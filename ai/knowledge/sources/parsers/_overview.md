# Source Parsers — Overview

Each `src/sources/<agent>/` directory exports a discover/collect pair that turns one
agent tool's on-disk session data into `NewBatch` rows in the local buffer DB.
Six `SOURCE_VARIANTS` are registered for the five agents (codex contributes both a
rollout JSONL variant and a state sqlite variant). `gemini` (Antigravity CLI + IDE)
is the newest source — a `sqlite_table_snapshot` whose `steps` rows carry a protobuf
`step_payload` that the gateway decodes to plaintext before redaction.

## Discover/collect surface (uniform)

Every parser exposes the same two-call pipeline used by the polling layer:

| Function (per source)            | Signature                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `discoverXxxFiles(baseDir, opts)` | `(string, { minimumMtime?: Date \| null, ... }) => Promise<DiscoveredXxxFile[]>`     |
| `collectXxxFile(file, ctx)`       | `(DiscoveredXxxFile, XxxCollectorContext) => Promise<XxxCollectorResult>`             |

`DiscoveredXxxFile` is the same shape across all four sources: `sourcePath`,
`sourcePathHash` (sha256), `inode`, `sizeBytes`, `lastModifiedMs`.

## File-watch layout

| Source       | Base dir (POSIX default)                         | Glob pattern(s)                                               | File kind |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------- | --------- |
| claude-code  | `~/.claude/projects`                             | `*/*.jsonl` (+ `*/*/subagents/*.jsonl` if sub-agent flag on) | JSONL append |
| codex rollout| `~/.codex`                                       | `sessions/*/*/*/rollout-*.jsonl`                              | JSONL append |
| codex state  | `~/.codex`                                       | `state_*.sqlite` (highest-numbered only)                      | sqlite (table snapshot) |
| cursor       | `~/Library/Application Support/Cursor/User` (macOS); `~/.config/Cursor/User` (linux); `%APPDATA%/Cursor/User` (win32) | `globalStorage/state.vscdb` + `workspaceStorage/*/state.vscdb` | sqlite (KV snapshot) |
| claude-desktop | `defaultClaudeDesktopSessionsRoot()` (branches on platform) | `*/*/local_*/audit.jsonl` (authoritative) + `.claude/projects/*/*.jsonl` (per-session CLI-metadata side input) | JSONL append |
| gemini       | `~/.gemini/antigravity-cli/conversations` + `~/.gemini/antigravity-ide/conversations` (both roots; via `homedir()`, no platform branch) | `*.db` (Cascade trajectory; both roots) | sqlite (table snapshot) |

Both the cursor and claude-desktop base dirs branch dynamically based on the target OS platform. All globs are
pinned-depth — `**/*.jsonl` is never used so we never silently start capturing unknown
content.

## Output batch shape (`NewBatch`, services/buffer/buffer.types.ts:11)

Every parser writes the same `NewBatch` interface into the buffer:

```ts
interface NewBatch {
  captureId: string;            // UUIDv7 generated at insert
  sourceApp: SourceApp;         // 'claude-code' | 'codex' | 'cursor' | 'claude-desktop' | 'gemini'
  sourcePlatform?: string | null; // Resolved platform identifier, e.g. 'claude-code-cli' or 'antigravity-ide'
  sourceKind: SourceKind;       // 'jsonl_append' | 'sqlite_kv_snapshot' | 'sqlite_table_snapshot'
  sourcePath: string;
  sourcePathHash: string;
  sourceInode: number | null;
  watermarkKind: WatermarkKind; // 'byte_range' | 'rowid_range'
  watermarkStart: number;
  watermarkEnd: number;
  watermarkTable: string | null;
  agentSchemaVersion: string;
  gatewayVersion: string;
  capturedAtUtc: string;
  bodyFormat: BodyFormat;       // 'jsonl' | 'kv_pairs_json' | 'sqlite_rows_json'
  bodyCompression: BodyCompression; // always 'zstd'
  body: Uint8Array;             // zstd(redact(filtered_text))
}
```

The wire DTO `RawRecordDTO` (contract.types.ts:37) is the same shape with `body`
base64-encoded.

## Where each parser diverges

| Concern              | claude-code            | codex rollout          | codex state            | cursor                 | claude-desktop         | gemini                 |
| -------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| Body format          | `jsonl`                | `jsonl`                | `sqlite_rows_json`     | `kv_pairs_json`        | `jsonl`                | `sqlite_rows_json`     |
| Watermark kind       | `byte_range`           | `byte_range`           | `rowid_range`          | `rowid_range`          | `byte_range`           | `rowid_range`          |
| `watermarkTable`     | `null`                 | `null`                 | `'threads'` or `'thread_spawn_edges'` | `null`  | `null`                 | `'steps'` / `'trajectory_meta'` / `'trajectory_metadata_blob'` |
| `sourceInode`        | file inode             | file inode             | `null`                 | `null`                 | file inode             | `null`                 |
| Splitter             | `splitJsonlAtBoundary` | `splitJsonlAtBoundary` | `splitRowsByCompressedSize` | `splitRowsByCompressedSize` | `splitJsonlAtBoundary` | `splitRowsByCompressedSize` |
| Version source       | embedded `version`     | embedded `payload.cli_version` (first line) | `threads.cli_version` (max-rowid) | `_v` from composer + bubble rows | `agentVersion` correlated from File A transcript | hard-coded constant (no upstream version string) |
| Version fallback     | `'unknown'`            | `'unknown'`            | `'unknown'`            | `'unknown:unknown'`    | `'claude-desktop/v2'`  | `'antigravity/1.0.0'`  |
| Initial watermark    | `0`                    | `0`                    | `1` (rowid space)      | `1` (rowid space)      | `0`                    | `-1` (rowid space; reads all) |
| Quarantine on oversize | throws fatal         | throws fatal           | `recordQuarantine` + advance cursor | `recordQuarantine` + advance cursor | throws fatal | `recordQuarantine` + advance cursor |
| VACUUM rehash        | n/a                    | n/a                    | yes (`detectVacuum`)   | yes (`detectVacuum`)   | n/a                    | yes (`detectVacuum`)   |
| Snapshot before read | n/a                    | n/a                    | `snapshotSqlite`       | `snapshotSqlite`       | n/a                    | `snapshotSqlite`       |
| Sub-agent exclude    | second glob skipped    | `thread_spawn_edges` join skip | n/a            | sql-level (currently no-op) | flag wired, no-op | n/a (`invoke_subagent` work lives in separate `.db` files) |
| Source-format parse  | line filter            | line filter + trim     | rows verbatim          | KV filter + trim       | line filter + reshape  | **protobuf `step_payload` → plaintext, then redact** |

JSONL parsers re-use a single in-collector `splitJsonlAtBoundary`; sqlite parsers
re-use `splitRowsByCompressedSize`. Both binary-search the largest prefix that fits
both the 2 MiB compressed and 10 MiB decompressed budgets defined in
`contract.constants.ts:78-84`.

`claude-desktop` is the one parser that reads **two** files: it watermarks the
authoritative `audit.jsonl` but, before shipping, enriches each kept record with
CLI metadata correlated from the session's `.claude/projects/*/*.jsonl` transcript
(`user` by `uuid`, `assistant` by `message.id`) and injects
`source_platform = 'claude-cowork-desktop'`. It reuses claude-code's
`isDialogueRecord` filter (plus an `isReplay` drop) but, unlike claude-code, rewrites
the record shape rather than shipping it verbatim. It and `gemini` are the two default
sources that are **not** worker-dispatched — the capture cycle routes only claude-code,
cursor, and codex to Bun Workers, so claude-desktop and gemini poll in-process. See
`ai/knowledge/sources/parsers/claude-desktop.md` and
`ai/knowledge/sources/parsers/gemini.md`.

`gemini` is the one parser whose source-format parse is a **protobuf decode**: each
`steps` row's `step_payload` blob is scanned into plaintext (`proto-scan.ts` +
`step-decode.ts`) **before** `applyRedaction` runs, so the redactor sees real message
text. It also reads from **two roots** (CLI + IDE) under one source, tagging each file
with `source_platform = antigravity-cli` / `antigravity-ide`.

## Parser version scheme

`agentSchemaVersion` is the **upstream agent's** version (the tool that wrote the
file), not a gateway-internal parser version. The gateway propagates whatever the
agent claims; gateway version travels separately in `gatewayVersion`. There is no
per-parser semver — parsers are versioned alongside the gateway binary (CalVer).

`gemini` is the exception: Antigravity conversation DBs carry no upstream version
string, so `agentSchemaVersion` is the hard-coded
`GEMINI_DEFAULT_AGENT_SCHEMA_VERSION = 'antigravity/1.0.0'`. That constant is the
parser-version anchor and must be bumped whenever the emitted row shape changes.

[source: src/sources/claude-code/collect.ts:200-403; src/sources/codex/collect-rollout.ts:97-303; src/sources/codex/collect-state.ts:21-141; src/sources/cursor/collect.ts:51-195; src/sources/claude-desktop/collect.ts; src/sources/gemini/collect.ts; src/sources/gemini/process-rows.ts; src/services/contract/contract.constants.ts:40-104; src/services/buffer/buffer.types.ts:11-28; src/services/polling/default-sources.ts]
