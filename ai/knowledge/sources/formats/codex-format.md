# codex File Formats

Codex produces two distinct on-disk artefacts and the gateway registers a source
variant for each.

## 1. Rollout JSONL — `sessions/YYYY/MM/DD/rollout-<id>.jsonl`

Append-only JSONL under `~/.codex/sessions/`. Each line is an event in a Codex
turn.

### Line envelope

Every record has the shape:

```json
{ "type": "...", "payload": { "type": "...", ... }, ... }
```

The first line is always a `session_meta` record carrying CLI/session metadata
including `payload.cli_version`. Subsequent lines stream events as the turn
progresses.

### Kept line types (`isCodexDialogueRecord`, collect-rollout.ts:52)

| Outer `type`     | Required `payload.type` / extra                    | Why kept                          |
| ---------------- | -------------------------------------------------- | --------------------------------- |
| `session_meta`   | (none)                                             | Carries `cli_version` and seeds session context |
| `event_msg`      | `task_started`, `task_complete`, `turn_aborted`, `token_count` | Turn-control markers (timing, abort, usage) |
| `response_item`  | `payload.type === 'message'` AND `payload.role ∈ {user, assistant}` | Actual dialogue text |

Everything else (tool plumbing, intermediate `event_msg` types, `response_item`s
that are not messages) is dropped.

### `session_meta` trimming (`trimCodexRecord`, collect-rollout.ts:80)

The `session_meta` payload is rewritten before serialization:

- `payload.base_instructions` → `'<trimmed>'`
- `payload.dynamic_tools` → `[]`

Other fields pass through. The two trimmed fields are typically huge (system
prompt + full tool schemas) and intentionally never leave the device.

### First-line version contract (`extractRolloutCliVersion`,
rollout-version.ts:7)

The first ≤1 MiB of the file is read, the first newline-terminated line is
parsed, and `payload.cli_version` is validated against `/^[\w.+:/-]{1,64}$/`. On
any failure (read error, JSON parse error, missing field, regex mismatch) the
function returns `null` and the collector falls back to the state-DB version
sample, then to `'unknown'`.

### Encoding and line discipline

- UTF-8.
- `\n`-terminated. Trailing partial lines are held until the next poll
  (`readJsonlRange` caps at last newline).
- `JSON.parse` failures per line are silently dropped.

### Sub-agent rollouts

When `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS[_CODEX]` is off (default), rollout files
whose path appears in `thread_spawn_edges JOIN threads.rollout_path` are
excluded at discovery — those are child-thread rollouts spawned by a parent. The
state DB is the source of truth for the parent/child link.

## 2. State SQLite — `state_<N>.sqlite`

A rolling sqlite database under `~/.codex/` carrying authoritative thread
metadata. Filename pattern is `state_<integer>.sqlite`; the highest-numbered
file is the live one (older files are rotation residue and ignored).

### Tables (`CODEX_ALLOWED_STATE_TABLES`)

Three tables exist in Codex; the gateway allow-list captures **two**:

| Table                  | Captured? | Purpose                                          |
| ---------------------- | --------- | ------------------------------------------------ |
| `threads`              | yes       | One row per thread; carries `cli_version`, `rollout_path`, and per-thread metadata |
| `thread_spawn_edges`   | yes       | Parent → child thread spawn edges (used to exclude sub-agent rollouts) |
| `thread_dynamic_tools` | no        | Defined as a constant but excluded — large, low-value |

### Row capture

For each allowed table:

```sql
SELECT rowid, *
FROM "<table>"
WHERE rowid > ?
ORDER BY rowid ASC
```

with the bound parameter being `watermarkEnd - 1`. Rows are serialized as
`JSON.stringify(sliceArray)` and split by `splitRowsByCompressedSize`.

The body envelope is the bare array (no `{ rows: [...] }` wrapper — that
wrapping is cursor-specific). Each row includes the synthetic `rowid` column.

### Version field

`threads.cli_version` is the canonical source. `sampleCliVersion`
(collect-state.ts:123) picks the **max rowid** row's value
(`ORDER BY rowid DESC LIMIT 1`) where `cli_version != ''`. Falls back to
`'unknown'`. This sampled version is also threaded into the rollout collector
as a fallback when the rollout's first line can't supply one.

### VACUUM detection

Per-table cursor stores `lastSeenSizeBytes` and `lastSeenPageCount`.
`resolveSourceIdentity` (resolve-state-identity.ts:15) compares these with
current values and `maxRowid(db, table)`; any of `size_decreased`,
`page_count_decreased`, or `rowid_regressed` triggers a `nextGenerationSuffix`
re-key (`<path>#gen-N`) and a fresh `sourcePathHash`. The new identity restarts
at `rowid > 0`.

### Read-only access discipline

- `snapshotSqlite(file.sourcePath)` produces a temp copy; the live writer is
  never blocked.
- `openReadOnly(snapshot.path)` uses bitwise flags
  (`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`); no `?immutable=1` URI hack.
- The discovery-time `readChildRolloutPaths` opens the **live** state DB
  (not the snapshot) for a single read-only metadata query. Failure is
  swallowed (empty exclude set, fail-open).

[source: src/sources/codex/codex.constants.ts:9-40; src/sources/codex/collect-rollout.ts:52-105; src/sources/codex/rollout-version.ts:1-39; src/sources/codex/collect-state.ts:123-142; src/sources/codex/collect-state-table.ts:38-283; src/sources/codex/resolve-state-identity.ts:15-70; src/sources/codex/discover.ts:111-173]
