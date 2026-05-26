[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Codex — capture decisions and product selections

> Two artifacts per Codex install: JSONL rollouts under `~/.codex/sessions/` and a numbered SQLite state file at `~/.codex/state_<N>.sqlite`. The gateway captures both. It parses each rollout line and keeps only the dialogue records (`session_meta`, turn-control `event_msg`, `response_item` messages), allow-lists two tables out of the state file, and ignores the rest of `~/.codex/`.

Codex is the only source that registers **two** entries in `SOURCE_VARIANTS` — one for jsonl rollouts, one for the sqlite state file — and that asymmetry shapes everything: rollouts use byte-range watermarks, then parse-filter-trim each line so the body carries only conversation-relevant records; state captures use rowid-range watermarks per table and only ship rows from an allow-list.

## Where the data lives

| Item | Value |
| --- | --- |
| Base directory | `~/.codex` (`CODEX_HOME_SUBPATH`) |
| Rollout glob | `sessions/*/*/*/rollout-*.jsonl` (`CODEX_ROLLOUT_GLOB`) — depth pinned to `YYYY/MM/DD/rollout-<id>.jsonl` |
| State glob | `state_*.sqlite` (`CODEX_STATE_GLOB`) — at base level only |
| Rollout source kind | `jsonl_append`, body `jsonl`, watermark `byte_range` |
| State source kind | `sqlite_table_snapshot`, body `sqlite_rows_json`, watermark `rowid_range` |
| Watermark table required (state)? | **Yes** — every state batch carries the table name |

### Highest-numbered state file wins

Codex's own writer only ever appends to the **highest-numbered** `state_<N>.sqlite` (the number increments when Codex itself rotates the file). `discoverCodexStateSqlite` parses the integer suffix from every match and emits at most one DiscoveredCodexStateFile — the maximum. Older `state_<N>.sqlite` files stay on disk but the gateway never reads them.

This is a deliberate trade-off: the older files are immutable, so we know nothing new will appear in them, and skipping them avoids re-ingesting yesterday's threads every cycle.

### Safe SQLite State Snapshots via Double-Attempt Lock Rescue

Because both the Codex Desktop and Codex CLI apps can run concurrently and perform frequent write transactions to `state_<N>.sqlite`, read attempts by the gateway are prone to database locks, triggering `SQLITE_CANTOPEN` ("unable to open database file") errors.

To guarantee conflict-free, point-in-time capture, the gateway's database reader implements a robust double-attempt rescue flow:
1. **Initial Open**: The gateway attempts to establish a standard read-only connection to the state file using `openReadOnly`.
2. **Rescue Retry (`immutable: true`)**: If the initial open is rejected due to active write locks or pending journal/WAL logs, the reader immediately retries the connection with the `immutable: true` option (setting the `immutable=1` URI search parameter). This tells SQLite that the database is on read-only media and can be safely read while ignoring any active WAL, locks, or journal writes.
3. **Fail-Safe Propagation**: If both attempts fail, the original error is thrown, ensuring genuine file or permission problems are not masked.

This double-attempt retry strategy ensures telemetry capture never locks up the active Codex apps and prevents gateway polling errors.

## CLI vs. Desktop Unified Collection

OpenAI Codex operates as both a **Codex CLI/TUI** (terminal application) and a **Codex Desktop** app (standalone Electron-based client). Rather than registering separate telemetry sources, the gateway evaluates and collects their telemetry cohesively as a single unified **`codex`** source.

### Shared Storage Architecture
Both applications share the exact same user home workspace at `~/.codex` and coordinate their data storage:
* **Session Rollouts**: Both apps write JSONL chat rollouts to the same `~/.codex/sessions/YYYY/MM/DD/rollout-<thread-id>.jsonl` structure.
* **SQLite State Database**: Both apps write thread details, spawned sub-agents, and dynamic tools into the active, highest-numbered `state_<N>.sqlite` file.
* **Gateway Discovery**: The gateway's `discoverCodexRolloutFiles` and `discoverCodexStateSqlite` discover and capture telemetry from this single path. Both apps are polled under a single `'codex'` source variant.

### Ingestion & Backend Separation
Although the gateway collects their data in a single stream, the downstream backend (`proxai_nest`) differentiates and segments the transcripts based on the `session_meta` header line (the first line in each rollout file):
* **Codex CLI/TUI**: Session metadata carries `source: "cli"` / `originator: "codex-tui"`.
* **Codex Desktop**: Session metadata carries `source: "vscode"` / `originator: "Codex Desktop"`.

The backend inspects these metadata fields (`originator` / `cli_version` / `source` / `model_provider`) during the ingestion process, enabling proper telemetry attribution and separation while keeping the gateway's capture layer unified and extremely light.


## What gets captured

### Rollouts (`jsonl_append`)

The gateway reads the new byte range, splits it on `\n`, and parses every line. A line is kept only if `isCodexDialogueRecord` returns true:

- `type === 'session_meta'` — kept (the per-rollout header).
- `type === 'event_msg'` — kept only when the nested `payload.type` is one of `task_started`, `task_complete`, `turn_aborted`, `token_count` (the turn-lifecycle and token-usage events; allow-list constant `CODEX_TURN_CONTROL_EVENT_MSG_TYPES`).
- `type === 'response_item'` — kept only when `payload.type === 'message'` **and** `payload.role` is `user` or `assistant` (the conversation messages).

Every other line is dropped before the body is built. Each kept record is then passed through `trimCodexRecord` (see below), re-serialised, joined back with `\n`, and that filtered-and-trimmed text becomes the body after redaction. The body is therefore a JSONL stream of only the records above — not the file's raw bytes.

| What | Captured? | Notes |
| --- | --- | --- |
| Parent-thread `session_meta` records | **Yes** | Trimmed: `base_instructions` replaced with `"<trimmed>"`, `dynamic_tools` emptied to `[]`. |
| Parent-thread turn-control `event_msg` records | **Yes** | Only `task_started` / `task_complete` / `turn_aborted` / `token_count`. Shipped unchanged. |
| Parent-thread `response_item` conversation messages | **Yes** | Only `payload.type === 'message'` with `role` `user` or `assistant`. Shipped unchanged. |
| Spawned child-thread rollouts | **No** by default — re-enabled via maintainer flag | The rollout glob matches the same `sessions/YYYY/MM/DD/rollout-<thread-id>.jsonl` shape for parent and child threads alike. To distinguish them, `discoverCodexRolloutFiles` pre-queries the highest-numbered `state_*.sqlite` (`SELECT t.rollout_path FROM thread_spawn_edges e JOIN threads t ON e.child_thread_id = t.id`) and excludes any rollout whose absolute path appears in the result. Pre-fetch errors are caught — fail-open — so a missing or unreadable state file does not block parent capture. Gated behind `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` (global) or `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX` (per-source). See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md). |
| File rotation by inode | Handled | New rollout file at a new path = new cursor row. |
| Agent schema version | Best-effort | `extractRolloutCliVersion(sourcePath)` reads the `cli_version` field from the first `session_meta` line. Falls back to `unknown`. |

The byte-range watermark still advances over the **entire** new range read (the physical end offset of the last line), so dropped lines are never re-scanned on the next cycle. A range that yields zero kept lines advances the cursor and produces no batch.

### State SQLite — allow-listed tables

`CODEX_ALLOWED_STATE_TABLES` enumerates exactly two tables. Each gets its own cursor row keyed by `(source_path_hash, source_inode, watermark_table)`:

| Table | What's in it | Captured? |
| --- | --- | --- |
| `threads` | One row per Codex thread: `id`, `rollout_path`, timestamps, `cwd`, `model_provider`, `title`, `first_user_message`, `cli_version`, `model`, `git_*` | **Yes** |
| `thread_spawn_edges` | Parent→child thread linkage: `(parent_thread_id, child_thread_id, status)` | **Yes** — captured regardless of the sub-agent flag. Linkage always reaches nest; the flag only controls whether the child's conversational rollout is shipped. |

Each new row in either table, since the cursor's `watermark_end`, is wrapped into a `sqlite_rows_json` body and shipped. The watermark advances to `max(rowid) + 1`.

## What gets skipped

### Skipped rollout records

Within a captured rollout file, every line that is not a dialogue record is dropped before the body is assembled:

| Dropped record | Why skipped |
| --- | --- |
| `event_msg` types other than the four turn-control values — including `agent_message` and `user_message` | These are byte-duplicates of the conversation already carried on the `response_item` `message` channel. |
| `response_item` types other than `message` — `function_call`, `function_call_output`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `web_search_call` | Tool-call / tool-output / reasoning items; not the user↔assistant conversation. |
| `response_item` `message` records whose `role` is neither `user` nor `assistant` | Non-conversational message roles. |
| `turn_context` | Per-turn cwd / approval / sandbox envelope; operational, not transcript content. |

### Skipped tables in `state_*.sqlite`

These tables exist in the schema but the gateway never reads them:

| Table | What it stores | Why skipped |
| --- | --- | --- |
| `thread_dynamic_tools` | Per-thread tool definitions (dynamic / MCP tools added at runtime) | Tool inventory, not conversation graph data; not in `CODEX_ALLOWED_STATE_TABLES`. |
| `agent_jobs` | Codex's "agent jobs" feature header (CSV input + instruction + status) | Operational state; rollouts of spawned-by-job threads still land in `sessions/`, captured by the rollout glob. |
| `agent_job_items` | Per-row work items within a job, with `assigned_thread_id` linkage | Operational state. Linkage to actual conversations comes via `thread_spawn_edges` + the spawned thread's rollout. |
| `stage1_outputs` | Per-thread summarisation outputs (raw memory, rollout summary) | Internal Codex pipeline artifact; not conversation content. |
| `thread_goals` | Per-thread token budget / objective tracking | Operational meta. Not transcript content. |
| `jobs` | Generic job queue table | Worker scheduling state. |
| `backfill_state` | Codex's own backfill checkpoint | Internal pipeline state. |
| `device_key_bindings` | Per-device key bindings | Account / credentials. |
| `remote_control_enrollments` | Remote-control feature enrollments | Account / connectivity. |
| `_sqlx_migrations` | sqlx schema-migration ledger | Schema metadata. |

The bar for inclusion in `CODEX_ALLOWED_STATE_TABLES` is "carries conversation graph data the receiver needs to reconstruct a thread or its sub-agent linkage." Only `threads` and `thread_spawn_edges` clear it; the others do not.

### Skipped files elsewhere under `~/.codex/`

| Path | What it is | Why skipped |
| --- | --- | --- |
| `~/.codex/session_index.jsonl` | Two-field index: `id` + `thread_name` per thread | Redundant with `threads.title` / `threads.first_user_message` already captured. |
| `~/.codex/logs_2.sqlite` | App event log (`logs` table) | Application diagnostics, not conversation content. |
| `~/.codex/sqlite/codex-dev.db` | Automation / inbox feature tables | Separate feature; not the agent transcript path. |
| `~/.codex/state_<N>.sqlite` for `N` not maximal | Older state-file generations | Codex appends only to the highest; older files are immutable history we already captured at the time. |
| `~/.codex/auth.json`, `~/.codex/config.toml`, `~/.codex/installation_id` | Credentials / config | Not transcript content; not safe to ship. |
| `~/.codex/.tmp/`, `~/.codex/vendor_imports/`, `~/.codex/cache/`, `~/.codex/memories/`, `~/.codex/skills/`, `~/.codex/plugins/`, `~/.codex/shell_snapshots/` | Vendored fixtures, plugin caches, shell snapshots | Not transcript content. |

## What's inside a captured rollout line

Every rollout JSONL line has a top-level `type`. Only the three record kinds that pass `isCodexDialogueRecord` reach the body:

| `type` | Kept when | Payload | After `trimCodexRecord` |
| --- | --- | --- | --- |
| `session_meta` | always | `id`, `timestamp`, `cwd`, `cli_version`, `originator`, `model_provider`, `base_instructions`, `dynamic_tools` | `base_instructions` set to `"<trimmed>"`; `dynamic_tools` set to `[]`. All other fields unchanged. |
| `event_msg` | nested `payload.type` ∈ {`task_started`, `task_complete`, `turn_aborted`, `token_count`} | `payload.type`, payload-specific fields; `token_count` carries `last_token_usage` | Unchanged. |
| `response_item` | `payload.type === 'message'` and `payload.role` ∈ {`user`, `assistant`} | `payload.type`, `payload.role`, `payload.content` | Unchanged. |

Records of any other shape — `turn_context`, `event_msg` of other types (`agent_message`, `user_message`, …), and `response_item` of other types (`function_call`, `function_call_output`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `web_search_call`) — are dropped at capture time and never appear in the body.

## How the body lands on the wire

### Rollouts

| Field | Value |
| --- | --- |
| `body_format` | `jsonl` |
| `body_compression` | `zstd` (level 3) |
| Body content | The `session_meta`, turn-control `event_msg`, and `response_item` message records from the new byte range that pass `isCodexDialogueRecord`, each trimmed by `trimCodexRecord`, re-serialised, joined with `\n`, then redacted. Dropped lines are absent. |
| Watermark | `byte_range`, `(start, end)` are absolute byte offsets into the rollout file. The range still spans every line read — including dropped ones — so nothing is re-scanned. |
| `watermark_table` | empty string (`NO_TABLE_SENTINEL`) |

Because the kept records may be fewer than the lines read, the body can be much smaller than the watermark range it covers. An oversized filtered body is split into multiple batches by `splitJsonlAtBoundary` (target compressed size), each carrying a sub-slice of the byte range.

### State tables

| Field | Value |
| --- | --- |
| `body_format` | `sqlite_rows_json` |
| `body_compression` | `zstd` (level 3) |
| Body content | JSON array of `{rowid, …<all columns>}` for new rows in the named table, after redaction. |
| Watermark | `rowid_range`, `(start, end)` are sqlite rowids in the named table. |
| `watermark_table` | One of `threads` / `thread_spawn_edges`. |
| Oversize handling | A single row whose redacted JSON exceeds 10 MiB is recorded in `quarantined_records` (metadata only, no body) and the cursor skips past it. |

A capture cycle that finds new rows in both tables produces **two** batches with the same `source_path_hash` and two different `watermark_table` values. The server-side watermark sync preserves this 1-source-N-tables shape.

## How the receiver parses the body

### Rollouts

1. **Receive + validate.** Split on `\n`, persist each line into `agent_raw_captures`.
2. **Extract chats.** Group rollout lines by `session_meta.id` (the thread id). One chat = one rollout file. `chatId` is the bare thread id; `agentId` is always `null` for Codex (no native sub-agent record-level discriminator).
3. **Parse chat.** Walk records in stream order. `response_item` payloads with `type: 'message'` produce turn content. `event_msg` `token_count` payloads feed the per-turn token counts.
4. **Finalize turn.** One `agent_call_records` row per turn.

### State tables

State-table batches don't go through the chat-parse pipeline. They land in `agent_raw_captures` keyed by `(source_path_hash, watermark_table)` and the receiver joins them in at the read side:

- `threads` rows seed the chat-header projection (title, model, cwd, git context).
- `thread_spawn_edges` rows reconstruct the parent→child thread tree.

The same `source_path_hash` is shared across both table cursors because they come from the same `state_<N>.sqlite` file; they're differentiated only by `watermark_table`.

## Per-source quirks

- **No sub-agent record discriminator at line level.** Unlike Claude Code (which puts `agentId` on every sub-agent line), Codex distinguishes parent vs. child threads purely by `thread_spawn_edges`. A child thread's rollout JSONL looks identical to a parent's — the rollout is "self-contained" per thread.
- **VACUUM detection runs against the state sqlite.** `detectVacuum` compares `last_seen_size_bytes` / `last_seen_page_count` / `max(rowid)+1` against the cursor row; a regression flips the source path to `#gen-N` and starts a new cursor at rowid 0.
- **Codex rotates `state_<N>.sqlite` by integer.** When the daemon next discovers a higher-numbered state file, the lower-numbered cursor stays put (no new writes) and a new cursor for the higher number starts at rowid 0. Two new table cursors get created on the new generation — one per allow-listed table.
- **Rollout files are append-only after creation.** No mid-file rewrites; byte-range watermarks are stable.
- **Schema-version probing reads the first `session_meta` line.** Costs a single small read; if absent, `agent_schema_version = "unknown"`.

## Skipped-content reality check

| Concern | Status |
| --- | --- |
| Are we missing sub-agent (child-thread) transcripts? | **By default, yes — intentionally.** Spawned-thread rollouts are filtered out at discovery time via a JOIN against `thread_spawn_edges` / `threads`. Re-enable with `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CODEX` (or the global flag). The parent → child linkage in `thread_spawn_edges` is captured regardless. |
| Are we missing thread metadata for parents? | No. `threads` carries title, model, provider, cwd, git context, first_user_message. |
| Are we missing the duplicate conversation channel? | Yes, by design. `event_msg` `agent_message` / `user_message` records are byte-duplicates of the `response_item` `message` channel; the gateway keeps the `response_item` copy and drops the duplicate. |
| Are we missing tool calls and reasoning? | Yes, by design. `response_item` `function_call` / `function_call_output` / `reasoning` / `custom_tool_call` / `custom_tool_call_output` / `web_search_call` records are dropped at capture time. |
| Are we missing turn-context envelopes? | Yes, by design. `turn_context` records are dropped; the turn-control `event_msg` types (`task_started` / `task_complete` / `turn_aborted` / `token_count`) are kept. |
| Are we missing tool definitions? | Yes, by design. `thread_dynamic_tools` is not in `CODEX_ALLOWED_STATE_TABLES`, and `session_meta.dynamic_tools` is emptied to `[]` by `trimCodexRecord`. |
| Are we missing job-orchestration state? | Yes — `agent_jobs` / `agent_job_items` / `thread_goals` are skipped. If product wants job-level analytics (queue depth, success rate, per-job thread tree), this is the namespace to enable. |
| Are we missing app diagnostics? | Yes — `logs_2.sqlite` and `codex-dev.db` are skipped by design. Out of scope for transcript capture. |

For comparison: [Cursor](./cursor.md) deliberately filters a much larger byte-volume namespace and exposes a similar maintainer escape hatch.

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
