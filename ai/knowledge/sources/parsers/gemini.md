# gemini Parser

The `gemini` source captures **Antigravity** Cascade conversation
databases from two roots (CLI + IDE) under a single
`GEMINI_SOURCE_APP = 'gemini'`. It is a `sqlite_table_snapshot` source —
the same family as codex state and cursor — but with one source-unique
twist: each captured `steps` row's `step_payload` is a **protobuf blob**
that the gateway decodes into plaintext **before** redaction, so the
user's message text is visible to the redactor (it would otherwise be
base64-hidden and leak). The on-disk format is documented in
`ai/knowledge/sources/formats/antigravity-format.md`.

## Files watched

- CLI root: `~/.gemini/antigravity-cli/conversations` (`defaultGeminiCliConversationsDir`) → `source_platform = antigravity-cli`.
- IDE root: `~/.gemini/antigravity-ide/conversations` (`defaultGeminiIdeConversationsDir`) → `source_platform = antigravity-ide`.
- Glob: `*.db` (`GEMINI_CONVERSATIONS_GLOB`) — pinned depth, file-level, never `**`. Legacy `.pb` siblings are not matched.
- Roots resolve cross-platform via `homedir()` + `join(...)`; no `process.platform` branch.

## Discovery (`discoverGeminiConversations`, discover.ts)

1. `statFile(baseDir)` early-return when the root does not exist.
2. `Bun.Glob('*.db').scan({ cwd: baseDir, onlyFiles: true })`.
3. For each match: stat, apply the `minimumMtime` filter, and push a
   `DiscoveredGeminiFile` with `sourcePath`, `sourcePathHash`
   (`sha256Hex(sourcePath)`), `inode`, `sizeBytes`, `lastModifiedMs`, and
   the `sourcePlatform` of this root.

The poller (`makeGeminiSourcePoller`, poll-gemini.ts) scans **both**
roots, tagging CLI files `antigravity-cli` and IDE files
`antigravity-ide` via `geminiPlatformForRoot(rootKind)`, concatenates the
two file lists, and collects each file sequentially. A discovery error on
one root is recorded and that root yields an empty list (the other root
still proceeds).

## Source-format parse: protobuf decode (the source-unique piece)

Two pure modules do the decode, both **total / never-throws**:

- `proto-scan.ts` — `scanProto(bytes)` is a minimal protobuf wire-format
  scanner returning a `FieldTree` (`Map<fieldNumber, FieldVal[]>`). Tag =
  `field << 3 | wire`; wire 0=varint, 1=fixed64, 2=length-delimited,
  5=fixed32. Length-delimited slices are kept as bytes, decoded to a UTF-8
  `str` when they round-trip cleanly (fatal decode + printable-control
  check), and recursively re-scanned into a nested `msg` when they parse
  to the end with plausible tags (depth-capped at 16). On any
  malformed/truncated input it stops and returns what parsed so far.
  Helpers: `getPath(tree, '5.4.2')`, `pStr`, `pNum`.
- `step-decode.ts` — `decodeStep(stepType, payload)` walks the field map
  into a `NormalizedStep` of **plaintext** fields, then `decodeStepRow`
  flattens it to the wire row. Plus `decodeTrajectoryMetaRow` (no
  protobuf — straight from columns) and `decodeTrajectoryMetadataBlobRow`
  (scans the blob for `workspace_path` / `git_remote`).

Role derivation (`roleForStep`): `step_type === 14` → `user`; `{90,98,101}`
→ `system`; `{5,7,8,9,17,21,25,31,33,127,132,138}` → `tool`; `{15,23}` →
`assistant`; otherwise fall back to the `5.3` discriminator (`4`→user,
`2`→tool, `5`→assistant), else `null`.

Text source per `step_type` (`textForStep`): 14→`19.2`, 15→`20.3`,
23→`30.4`, 90→`103.1`, 98→`111.1`, 101→`114.1`||`114.2.2`, 31→`40.2.6.3.2`,
25→`34.11`||`34.14`, 132→`140.2.1`; all other steps emit `text: null` (the
opaque tool-result blob is never used as text). `toolName` =
`5.4.2`||`20.7.2`||`5.4.9`; `toolArgsJson` = `5.4.3`||`20.7.3`. ISO
timestamp is computed from `5.1.{1,2}` (epoch seconds + nanos). `model`,
`inputTokens`, `outputTokens` are always emitted `null` in v1 (the model
display name + ground-truth tokens require a `gen_metadata` join that is
not captured).

## Capture (`collectGeminiConversation` → `collectOneGeminiTable`)

Mirrors the codex state-table collector:

1. `snapshotSqlite(file.sourcePath)` → temp copy (the Antigravity writer is
   never blocked); `openReadOnly(snapshot.path)`; `cleanup()` in `finally`.
2. `resolveGeminiIdentity` (resolve-identity.ts): for each allowed table
   with a prior cursor, run `detectVacuum` against current `sizeBytes` /
   `pageCount(db)` / `maxRowid(db, table)`. Any of `size_decreased` /
   `page_count_decreased` / `rowid_regressed` re-keys the source via
   `nextGenerationSuffix(path)` (`#gen-N`) + a fresh `sourcePathHash`, and
   the cursor is treated as absent so capture restarts at `rowid > -1`.
3. For each table in `GEMINI_ALLOWED_TABLES`
   (`trajectory_meta`, `steps`, `trajectory_metadata_blob`):
   skip if `!tableExists(db, table)`; read new rows with
   `SELECT rowid AS rid, … FROM "<table>" WHERE rowid > ? ORDER BY rowid ASC`
   bound to `watermarkEnd - 1`; **decode each row's protobuf BLOB into a
   plaintext row object** via step-decode; then redact + split + compress
   + insert.
4. Per-table errors are caught individually (`bumpConsecutiveErrors`) so a
   failure in one table does not abort the others; an outer catch covers
   snapshot/open/identity.

### Redaction runs on the decoded plaintext (load-bearing)

`createSliceMeasurer` builds the JS array of decoded row objects, then
`applyRedaction(JSON.stringify(rows)).redacted` — redaction sees **real
text** because the protobuf was already decoded. Were `step_payload`
shipped as base64 protobuf, redaction would be blind and PII would leak.
This is why the decoder lives in the **gateway**, not nest. The measurer
caches `{redactedJson, rawBytes, compressed}` per slice via a `WeakMap`,
and `splitRowsByCompressedSize` finds the largest prefix that fits both
the `BODY_TARGET_COMPRESSED_BYTES` and `maxDecompressedBytes` budgets.

## Output `NewBatch` (one batch per `watermarkTable`)

| Field | Value |
| --- | --- |
| `sourceApp` | `'gemini'` |
| `sourcePlatform` | `'antigravity-cli'` or `'antigravity-ide'` (from the file's root) |
| `sourceKind` | `'sqlite_table_snapshot'` |
| `bodyFormat` | `'sqlite_rows_json'` |
| `bodyCompression` | `'zstd'` |
| `watermarkKind` | `'rowid_range'` |
| `watermarkTable` | one of `steps` / `trajectory_meta` / `trajectory_metadata_blob` |
| `watermarkStart` / `watermarkEnd` | first rowid in slice / `lastRowid + 1` |
| `sourceInode` | `null` |
| `agentSchemaVersion` | `GEMINI_DEFAULT_AGENT_SCHEMA_VERSION = 'antigravity/1.0.0'` |
| Body content | `JSON.stringify(decodedRows)` of the plaintext, already-redacted row objects |

### Per-table body shapes

- `steps` → `{ idx, step_type, status, role, text, tool_name, tool_args_json, iso_timestamp, turn_id, conversation_id }` (text + tool_args_json redacted; `conversation_id` = `cascade_id` from the payload).
- `trajectory_meta` → `{ idx, trajectory_id, cascade_id, trajectory_type, source }` (usually 1 row; `cascade_id` is the downstream `chat_id`).
- `trajectory_metadata_blob` → `{ idx, workspace_path, git_remote }` (decoded from the blob; redacted).

## Parser version scheme

Unlike claude-code / codex / cursor (which read the upstream tool's own
version from the file), Antigravity has no per-conversation version
string, so `agentSchemaVersion` is the hard-coded
`GEMINI_DEFAULT_AGENT_SCHEMA_VERSION = 'antigravity/1.0.0'`. This constant
is the **parser-version anchor** — any change to the emitted row shape
(adding/removing a field, retyping, changing the decode interpretation)
must bump it per the parser-version-bump rule.

## Watermark handling

- Cursor key: `(sourceApp='gemini', sourcePathHash, sourceInode=null, watermarkTable)` — one cursor row **per allowed table** of the same `.db`. They share the `sourcePathHash`; the table name differentiates them.
- Initial watermark: absent cursor → `lastMaxRowid = -1` (read everything); success advances to `lastRowid + 1`. On error, `watermarkEnd` is held unchanged with `consecutiveErrors: priorErrors + 1` (never regressed).
- VACUUM re-key restarts the rotated DB at rowid 0 under a `#gen-N` path + fresh hash, so the server treats it as a new source.

## Quarantine / oversize

A slice whose redacted JSON still exceeds `maxDecompressedBytes` is written
to `quarantined_records` (metadata only, no body) via `recordQuarantine`,
and the cursor advances **past** the quarantined rowid so the cycle keeps
making progress. `consecutiveErrors` is bumped for the table.

## Polling / dispatch

- Registered once as a `gemini` `RegisteredSource` in `buildDefaultSources` (`default-sources.ts`), with optional `geminiCliBaseDir` / `geminiIdeBaseDir` injectable overrides.
- `SOURCE_NAME_GEMINI: SourceApp = 'gemini'` (`polling.constants.ts`).
- **Not worker-dispatched.** The capture cycle routes only `claude-code`, `cursor`, and `codex` to Bun Workers (`capture-cycle.ts`: `isDefaultSource`); `gemini` (like `claude-desktop`) runs **in-process** via `source.poll`. The `poll-worker.ts` `gemini` branch is the **inspect/doctor** path only — it counts `steps` rows and `step_type = 14` prompts for the doctor surface.

## Gotchas

- **Decode before redact.** Never ship `step_payload` as base64 protobuf — redaction must see plaintext (§ Redaction runs on the decoded plaintext).
- **Never infer the tool from `step_type`.** Read the embedded `5.4.2` / `20.7.2` tool name. Types 5, 17, and 132 each host several tools.
- **Stub rows are normal.** ~3% of type-5 and ~20% of type-17 rows have no `5.4` envelope (null `tool_name`); the row stays addressable by `(cascade_id, idx)`.
- **`model` / token usage are best-effort null in v1.** The display name + ground-truth tokens live in `gen_metadata`, which is not in `GEMINI_ALLOWED_TABLES`.
- **One `.db` = up to three table cursors.** A cycle with new rows in all three tables produces three batches sharing one `source_path_hash`.

[source: src/sources/gemini/discover.ts; src/sources/gemini/source-platform.ts; src/sources/gemini/proto-scan.ts; src/sources/gemini/step-decode.ts; src/sources/gemini/collect.ts; src/sources/gemini/process-rows.ts; src/sources/gemini/resolve-identity.ts; src/sources/gemini/gemini.constants.ts; src/services/polling/poll-gemini.ts; src/services/polling/default-sources.ts; src/services/polling/capture-cycle.ts; src/services/polling/poll-worker.ts; src/services/contract/contract.constants.ts]
