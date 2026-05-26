# codex Parser

Codex is the only agent with **two** registered source variants: append-only
`rollout-*.jsonl` files and a snapshot-style `state_*.sqlite`. They share a
`CODEX_SOURCE_APP = 'codex'` and a `CodexCollectorContext` but have separate
collect entry points and watermark schemes.

## Files watched

- Base dir: `~/.codex` (`CODEX_HOME_SUBPATH`). No platform branching.
- Rollout glob: `sessions/*/*/*/rollout-*.jsonl` (`CODEX_ROLLOUT_GLOB`). Pinned
  depth (year/month/day/rollout file).
- State glob: `state_*.sqlite` (`CODEX_STATE_GLOB`). Discovery picks the
  **highest-numbered** file only (`pickHighestNumberedState`, discover.ts:160) —
  older state files are ignored.

## Discovery

### Rollouts (`discoverCodexRolloutFiles`, discover.ts:31)

1. `statFile(baseDir)` early-return.
2. Resolve the exclude set: if the sub-agent flag is off, open the state sqlite
   read-only and run
   `SELECT t.rollout_path FROM thread_spawn_edges e JOIN threads t ON
   e.child_thread_id = t.id` — every returned `rollout_path` is excluded from the
   rollout walk. State-DB open failures degrade to an empty exclude set
   (fail-open).
3. Walk `CODEX_ROLLOUT_GLOB` with the mtime filter and exclude set.

### State (`discoverCodexStateSqlite`, discover.ts:79)

Returns at most one `DiscoveredCodexStateFile`. The chosen filename must match
`/^state_(\d+)\.sqlite$/` and have the highest integer suffix. Older files exist
on disk (rotation artefacts) but are intentionally not read.

## Capture format (input)

- Rollouts: JSONL. Each line is `{ type, payload, ... }`; the first line is a
  `session_meta` record containing `payload.cli_version`. Format details in
  `ai/knowledge/sources/formats/codex-format.md`.
- State: SQLite database with tables `threads`, `thread_dynamic_tools`,
  `thread_spawn_edges`. Only `threads` and `thread_spawn_edges` are in the
  allow-list (`CODEX_ALLOWED_STATE_TABLES`).

## Rollout collection (`collectCodexRollout`, collect-rollout.ts:97)

Same JSONL pipeline as claude-code with these differences:

- `isCodexDialogueRecord` (collect-rollout.ts:49) keeps `type === 'session_meta'`,
  `type === 'event_msg'` whose `payload.type` is one of
  `task_started | task_complete | turn_aborted | token_count`, and
  `type === 'response_item'` whose `payload.type === 'message'` and
  `payload.role ∈ {user, assistant}`.
- `trimCodexRecord` (collect-rollout.ts:77) rewrites the `session_meta` payload:
  `base_instructions` becomes `'<trimmed>'` and `dynamic_tools` becomes `[]` to
  cap line size before redaction.
- `agentSchemaVersion`: `extractRolloutCliVersion` (rollout-version.ts:7) reads the
  **first ≤1 MiB**, parses the first line, validates `payload.cli_version` against
  `/^[\w.+:/-]{1,64}$/`. Falls back to the value passed in from
  `collectCodexState`'s `threads.cli_version` sample, then `'unknown'`.
- `sourceInode` populated; watermark kind `byte_range`; same kept-line offset math
  as claude-code; oversized slices throw `OversizedDecompressedSliceError` (no
  quarantine path on the JSONL side).

## State collection (`collectCodexState`, collect-state.ts:21)

1. `snapshotSqlite(file.sourcePath)` → temp copy via Bun's snapshot API; the
   live writer is never blocked. `cleanup()` is awaited in `finally`.
2. `openReadOnly(snapshot.path)` — uses explicit bitwise flags
   (`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`); no `?immutable=1` query string.
   Double-attempt fallback in the underlying helper for transient errors.
3. `sampleCliVersion` (collect-state.ts:123): max-rowid pick from
   `threads.cli_version` (filtered `!= ''`). Falls back to `'unknown'`.
4. `resolveSourceIdentity` (resolve-state-identity.ts:15): for each allowed table,
   pull the cursor and run `detectVacuum` with current `sizeBytes` /
   `pageCount(db)` / `maxRowid(db, table)`. If any of `size_decreased`,
   `page_count_decreased`, `rowid_regressed` fires, the source is re-keyed via
   `nextGenerationSuffix(path)` (appends `#gen-N`) and a fresh `sourcePathHash`
   is computed; the cursor is treated as absent so capture restarts from
   `rowid > 0`.
5. For each allowed table (`threads`, `thread_spawn_edges`):
   `collectOneTable` (collect-state-table.ts:37) runs
   `SELECT rowid, * FROM "<table>" WHERE rowid > ?` with the prior watermark,
   measures per slice with `splitRowsByCompressedSize`, redacts
   `JSON.stringify(slice)` once per slice (cached), and either inserts each batch
   or records it as quarantine if the redacted size still exceeds 10 MiB. The
   cursor advances **past** quarantined rows so progress is never blocked.

## Output `NewBatch`

| Field            | Rollout                          | State                                     |
| ---------------- | -------------------------------- | ----------------------------------------- |
| `sourceApp`      | `'codex'`                        | `'codex'`                                 |
| `sourceKind`     | `'jsonl_append'`                 | `'sqlite_table_snapshot'`                 |
| `bodyFormat`     | `'jsonl'`                        | `'sqlite_rows_json'`                      |
| `watermarkKind`  | `'byte_range'`                   | `'rowid_range'`                           |
| `watermarkTable` | `null`                           | `'threads'` or `'thread_spawn_edges'`     |
| `sourceInode`    | real inode                       | `null`                                    |
| Body content     | JSONL of trimmed kept lines      | `JSON.stringify(rowsArray)` of selected rows |

## Parser version scheme

There is no separate codex parser version. Rollout `agentSchemaVersion` flows from
the file's first-line `cli_version`; state version flows from
`threads.cli_version`. The state version is read first and passed down to the
rollout collector as a fallback when the rollout's own first line lacks the field.

## Redaction integration

- Rollout: per-slice `createSliceRedactor` (collect-rollout.ts:35), identical
  pattern to claude-code.
- State: per-slice `createSliceMeasurer` (collect-state-table.ts:251) wraps
  `JSON.stringify(slice)` → `applyRedaction` → `zstdCompressSync`, cached per
  slice array via `WeakMap`. Splitter uses both the redacted byte length and the
  compressed byte length to find the largest prefix that fits.

## Watermark handling

- Rollout cursor key: `(sourceApp, sourcePathHash, sourceInode, table=null)`.
  Initial watermark `0`.
- State cursor key: `(sourceApp, sourcePathHash, sourceInode=null, table)` — one
  row per allowed table. Initial watermark `1` (rowid space; `rowid > end - 1`
  means we read everything).
- State cursor also tracks `lastSeenSizeBytes` and `lastSeenPageCount` so
  `detectVacuum` can compare on next poll.

## Dedup

- Rollouts: byte watermark per file; sub-agent rollouts excluded at discovery via
  `thread_spawn_edges` join (default off).
- State: per-table rowid watermark; vacuum re-key restarts at rowid 0 against a
  new `sourcePathHash`, so server treats the rotated DB as a new source.
- Server-side: `capture_id` UUIDv7 is the idempotency key.

## Idle-flush behavior

Poll-driven only (capture cycle 120 s). No per-source debounce. Both rollout and
state collectors are no-ops when nothing has changed.

## Error path

- Rollout: same single-catch pattern as claude-code — bump `consecutiveErrors`,
  keep `watermarkEnd`.
- State: outer `try` covers snapshot/open/identity; per-table inner `try` bumps
  `consecutiveErrors` for only the failed table via `bumpConsecutiveErrors`
  (collect-state.ts:91). Other tables in the same poll still progress.

## Gotchas

- State discovery silently picks the highest `state_N.sqlite`. If Codex rotates,
  the highest filename changes and the prior cursor (keyed on the prior path's
  hash) is orphaned. The vacuum detector does not catch this — only intra-file
  resets.
- `resolveExcludeRolloutPaths` opens the state sqlite **directly** (not through
  the snapshot helper) because it's a tiny read-only metadata query. Failure is
  swallowed so a corrupt state DB doesn't block rollout capture.
- Per-table errors in state collection do not abort the other tables; the outer
  result aggregates all failures.
- Quarantined state rows write a metadata-only record (`recordQuarantine`); body
  bytes never leave the device.
- `trimCodexRecord` mutates `payload.base_instructions` and `dynamic_tools`
  unconditionally for `session_meta` — these fields are intentionally never
  transmitted.

[source: src/sources/codex/codex.constants.ts:1-40; src/sources/codex/discover.ts:21-173; src/sources/codex/collect-rollout.ts:49-303; src/sources/codex/collect-state.ts:21-141; src/sources/codex/collect-state-table.ts:37-264; src/sources/codex/resolve-state-identity.ts:15-69; src/sources/codex/rollout-version.ts:1-38]
