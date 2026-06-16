[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Gemini (Antigravity) — capture decisions and product selections

*Last Updated: 2026-06-16*

> One artifact per Antigravity conversation: a SQLite "Cascade trajectory" database at `~/.gemini/antigravity-{cli,ide}/conversations/<cascadeId>.db`. Antigravity ships as a **CLI** and an **IDE** that write the identical format under two sibling directories, so the gateway uses **one** `gemini` source and tags each file with `source_platform = antigravity-cli` / `antigravity-ide`. The gateway allow-lists three tables, decodes each `steps` row's protobuf `step_payload` into plaintext, redacts it, and ships it. Gemini Desktop and the old Google Gemini CLI are out of scope.

Gemini is the gateway's first **protobuf-decoding** source. Its `steps` rows store the transcript as length-delimited protobuf blobs with no shipped `.proto`. The gateway decodes them to plaintext on-device **before** redaction — if the bytes were forwarded base64-encoded, the user's message text would be hidden from the redactor and PII would leak. That decode is Gemini's "source-format parse" step, exactly analogous to Codex parsing JSONL or Cursor parsing KV JSON. The receiver (`proxai_nest`) does **no** protobuf work — it receives clean, already-redacted JSON row objects.

## Scope: what is and isn't a Gemini source

| Surface | Path | In scope? |
| --- | --- | --- |
| **Antigravity CLI** | `~/.gemini/antigravity-cli/conversations/<cascadeId>.db` | **Yes** → `source_platform = antigravity-cli` |
| **Antigravity IDE** | `~/.gemini/antigravity-ide/conversations/<cascadeId>.db` | **Yes** → `source_platform = antigravity-ide` |
| Gemini Desktop (`com.google.GeminiMacOS`) | `~/Library/Application Support/com.google.GeminiMacOS` | **No** — only settings/auth/onboarding Core-Data stores; **no local conversation data on disk**. |
| Old Google Gemini CLI | — | **No** — deprecated; the gateway collects the Antigravity successor only. |
| Legacy `.pb` conversation files | `<cascadeId>.pb` siblings | **No** — pre-SQLite standalone-protobuf encoding; the glob matches `*.db` only. |
| `history.jsonl`, `cache/`, `config/projects/` | `~/.gemini/...` | **No** — prompt index / workspace map / project registry; the `.db` already carries prompts with richer context. |

CLI and IDE share the **same** Cascade trajectory format and differ only by parent directory — the "if only metadata changes, one parser" rule — so a single discover/collect pair handles both, and the only difference on the wire is the `source_platform` value.

## Where the data lives

| Item | Value |
| --- | --- |
| CLI root | `~/.gemini/antigravity-cli/conversations` (`defaultGeminiCliConversationsDir`) |
| IDE root | `~/.gemini/antigravity-ide/conversations` (`defaultGeminiIdeConversationsDir`) |
| Glob | `*.db` (`GEMINI_CONVERSATIONS_GLOB`) — pinned depth, file-level, never `**`, never `.pb` |
| Source kind | `sqlite_table_snapshot`, body `sqlite_rows_json`, watermark `rowid_range` |
| Watermark table required? | **Yes** — every batch carries the table name |
| Roots resolve | via `homedir()` + `join(...)` — same shape on macOS / Linux / Windows, no `process.platform` branch |

The poller (`makeGeminiSourcePoller`) scans **both** roots in one cycle, concatenates the file lists, and collects each `.db` sequentially. A discovery error on one root is recorded and that root yields an empty list; the other root still proceeds.

## The Cascade trajectory database

A conversation `.db` is a Windsurf/Cascade trajectory. Several tables exist; the gateway allow-lists **three** (`GEMINI_ALLOWED_TABLES`):

| Table | What's in it | Captured? |
| --- | --- | --- |
| `trajectory_meta` | One row: `trajectory_id`, `cascade_id` (== filename), `trajectory_type`, `source`. Conversation identity. | **Yes** |
| `steps` | The transcript. `idx INT PK` (== rowid), `step_type`, `status`, and a protobuf `step_payload` blob with recoverable plaintext. | **Yes** |
| `trajectory_metadata_blob` | One row (`id='main'`): a protobuf blob embedding the workspace URI + git remote/branch + project ids. | **Yes** |
| `gen_metadata`, `executor_metadata`, `parent_references`, `battle_mode_infos` | Per-generation model/token metadata, sandbox policy, sub-trajectory links, A/B-mode data. | **No** — not in the allow-list (model display name + ground-truth tokens live here; deferred). |

### `steps.step_type` is a render bucket, not a tool name

`step_type` is a coarse category; it does **not** name the tool. The authoritative tool identity is the string embedded in the payload (`5.4.2`, or `20.7.2` on type 15) — types `5`, `17`, and `132` each multiplex several tools. Verified buckets:

| step_type | role | meaning |
| --- | --- | --- |
| 14 | user | User message / prompt |
| 15 | assistant | Agent-step envelope (reasoning and/or a wrapped tool call) |
| 23 | assistant | Assistant turn container / final message |
| 5, 17 | tool | File-mutation / lite tool containers (multiplex several tools) |
| 7 | tool | grep_search |
| 8 | tool | view_file |
| 9 | tool | list_dir |
| 21 | tool | run_command |
| 25 | tool | find_by_name |
| 31 | tool | read_url_content |
| 33 | tool | search_web |
| 127 | tool | invoke_subagent (blocking; sub-work in separate `.db` files) |
| 132 | tool | management container (manage_task / schedule / list_permissions / …) |
| 138 | tool | ask_question (blocking) |
| 90 | system | injected ephemeral / system-reminder |
| 98 | system | injected conversation-history markdown |
| 101 | system | system `[Message]` event with inline ISO timestamp |

## Capture → decode → redact → upload

### 1. Snapshot and read

`snapshotSqlite(file.sourcePath)` makes a transactionally consistent temp copy (Antigravity's writer is never blocked), then `openReadOnly` opens it. Before reading, `resolveGeminiIdentity` runs `detectVacuum` against the stored cursor's size / page-count / `max(rowid)`; any of size-decreased / page-count-decreased / rowid-regressed re-keys the source path with a `#gen=N` suffix and a fresh hash, restarting capture at rowid 0.

For each allowed table the collector reads new rows with `SELECT rowid AS rid, … FROM "<table>" WHERE rowid > ? ORDER BY rowid ASC` bound to `watermarkEnd - 1`.

### 2. Decode the protobuf to plaintext

Two pure, **never-throws** modules turn each `steps` row's `step_payload` blob into a flat plaintext object:

- `proto-scan.ts` — a minimal protobuf wire-format scanner (`scanProto`) that walks field tags (`field << 3 | wire`), decoding length-delimited slices to UTF-8 strings when they round-trip cleanly and to nested messages when they parse to the end (depth-capped at 16). On any malformed or truncated byte it stops and returns what parsed so far.
- `step-decode.ts` — `decodeStep` maps the field tree (per `PROTOBUF-FIELDMAP.md`) into `{ role, text, tool_name, tool_args_json, iso_timestamp, turn_id, conversation_id, … }`. Role is derived from `step_type` (with a `5.3`-discriminator fallback); `text` is pulled from the type-appropriate prose field and **never** from the opaque tool-result blob; `tool_name` from `5.4.2`/`20.7.2`/`5.4.9`; timestamp from the `5.1` epoch-seconds+nanos pair.

`trajectory_meta` rows are read straight from columns (no protobuf); `trajectory_metadata_blob` is scanned for `workspace_path` + `git_remote`.

### 3. Redact the decoded plaintext (load-bearing)

The decoded row objects are serialized and run through `applyRedaction(JSON.stringify(rows))` — the redactor now sees **real** message text, tool args, workspace paths, and git remotes. This is why the protobuf decoder lives in the **gateway**, not the receiver: redaction must happen after decode, on-device, before any bytes leave the machine.

### 4. Split, compress, ship

`splitRowsByCompressedSize` finds the largest row prefix that fits both the target compressed budget and `maxDecompressedBytes`; each slice is zstd-compressed and inserted as one batch. A single row whose redacted JSON still exceeds the decompressed cap is recorded in `quarantined_records` (metadata only, no body) and the cursor advances past it so the cycle keeps progressing.

## What lands on the wire

| Field | Value |
| --- | --- |
| `source_app` | `gemini` |
| `source_platform` | `antigravity-cli` or `antigravity-ide` (from the file's root) |
| `source_kind` | `sqlite_table_snapshot` |
| `body_format` | `sqlite_rows_json` |
| `body_compression` | `zstd` (level 3) |
| Body content | JSON array of decoded, redacted row objects for new rows in the named table |
| Watermark | `rowid_range`, `(start, end)` are sqlite rowids; `end = max(rowid) + 1` |
| `watermark_table` | one of `steps` / `trajectory_meta` / `trajectory_metadata_blob` |
| `agent_schema_version` | `antigravity/1.0.0` (hard-coded; Antigravity has no upstream version string) |

### Body shapes per table

- **`steps`** → `{ idx, step_type, status, role, text, tool_name, tool_args_json, iso_timestamp, turn_id, conversation_id, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }`. `text` and `tool_args_json` are redacted; `role` is `user` / `assistant` / `tool` / `system` / `null`; `conversation_id` is the `cascade_id` from the payload. `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` are populated directly from the decoded step payload.
- **`trajectory_meta`** → `{ idx, trajectory_id, cascade_id, trajectory_type, source }` (usually 1 row; `cascade_id` is the downstream `chat_id`).
- **`trajectory_metadata_blob`** → `{ idx, workspace_path, git_remote }` (decoded from the blob; redacted).

A cycle that finds new rows in all three tables produces **three** batches sharing one `source_path_hash`, differentiated by `watermark_table` — the same 1-source-N-tables shape as Codex state.

## How the receiver parses the body

The receiver does **no** protobuf work — it `JSON.parse`s the already-decoded, already-redacted row arrays:

1. **Receive + validate.** Rows land in `agent_raw_captures` keyed by `(source_path_hash, watermark_table)`.
2. **Extract chats.** `chat_id = cascade_id` (from the `trajectory_meta` batch); fallback `source_path_hash` when no `trajectory_meta` row has arrived yet.
3. **Parse chat.** Walk `steps` rows in rowid order; a `role === 'user'` step opens a turn and subsequent `assistant` / `tool` / `system` steps buffer until the next user step.
4. **Finalize turn.** One `agent_call_records` row per turn: user text → query, last assistant text → final text, tool-name counts → tool summary, `google` provider (model best-effort), `source_platform` carried through. The `agent` value is the lowercase literal `gemini`.

## What gets skipped

| Skipped | Why |
| --- | --- |
| Legacy `.pb` conversation files | Pre-SQLite encoding; superseded by `.db`. The glob matches `*.db` only. |
| `gen_metadata` / `executor_metadata` tables | Model display name + ground-truth token totals live here; deferred. In v1, `model` and token usage emit best-effort `null`. |
| `parent_references` / `battle_mode_infos` | Sub-trajectory linkage / A-B-mode data; not transcript content. |
| `history.jsonl`, `cache/last_conversations.json`, `config/projects/` | Prompt index / workspace map / project registry; redundant with the `.db`. |
| Gemini Desktop stores | No local conversation data — only settings/auth/onboarding. |
| Tool RESULT blobs (`5.4.7.2.1`) | A proprietary opaque codec (constant magic `01 0c 39 d6 c7`, not zlib/gzip/zstd/deflate); not plaintext-decodable. The human-readable action is reconstructed from the tool args + summary fields instead. |

## Per-source quirks

- **Decode before redact.** Gemini is the only source whose body is binary on disk; the protobuf must be decoded to plaintext before `applyRedaction`, or redaction is blind.
- **Never infer a tool from `step_type`.** Read the embedded tool name; types 5, 17, and 132 each host several tools.
- **Stub rows are normal.** ~3% of type-5 and ~20% of type-17 rows lack the `5.4` envelope (null `tool_name`); the row stays addressable by `(cascade_id, idx)`.
- **Not worker-dispatched.** The capture cycle routes only `claude-code`, `cursor`, and `codex` to Bun Workers; Gemini (like Claude Desktop) polls **in-process**. The `poll-worker.ts` Gemini branch is the **inspect/doctor** path only — it counts `steps` rows and `step_type = 14` prompts.
- **One `.db` = up to three table cursors**, all sharing the source path hash and differentiated by `watermark_table`.
- **VACUUM detection runs against the `.db`.** A regression re-keys the source to `#gen=N` and restarts at rowid 0.

## Skipped-content reality check

| Concern | Status |
| --- | --- |
| Are we missing the message transcript? | No. `steps` rows carry user prompts, assistant text, tool calls + args, and system events as decoded plaintext. |
| Are we missing conversation identity / chat id? | No. `trajectory_meta.cascade_id` (== filename) is the `chat_id`. |
| Are we missing workspace / git context? | No. `trajectory_metadata_blob` is decoded to `workspace_path` + `git_remote`. |
| Are we missing the model name and token usage? | **No.** Model name and token metrics (`input_tokens`, `output_tokens`, cache read/creation tokens) are actively decoded directly from the protobuf `step_payload` in the `steps` table (using field paths like `5.9` and `5.11`). The `gen_metadata` table is still skipped, but basic model and token metrics are captured per step in the `steps` batches. |
| Are we missing sub-agent transcripts? | `invoke_subagent` (step 127) spawns sub-trajectories whose work lives in **separate** `.db` files; those are discovered and captured as their own conversations. The originating step still belongs to the opening turn. |
| Are we missing tool results? | The human-readable tool **action** is reconstructed from args + summary; the raw RESULT blob is an opaque proprietary codec and is not shipped. |
| Are we capturing legacy `.pb` files? | No, by design. Superseded by `.db`. |

For comparison: [Codex](./codex.md) is the other `sqlite_table_snapshot` source (allow-listing `threads` / `thread_spawn_edges`); Gemini differs in that its rows require an on-device protobuf decode before redaction.

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
