# buffer

`src/services/buffer/` is the bun:sqlite layer for everything captured-or-shipped. One file, one database (`buffer.db`), seven tables, no migrations framework.

## Open settings

- `openBufferDb(path)` calls `openReadWrite(path)` from `core/io/sqlite`, then `initializeSchema(db)`.
- File-backed DBs use `WAL` + `synchronous = NORMAL` + `foreign_keys = ON` (set by `openReadWrite`). `0o600` perms enforced post-open on POSIX.
- `openInMemoryBufferDb()` is provided for capture workers (`new Database(':memory:')` + `PRAGMA foreign_keys = ON;`). Workers commit results back to the main DB via the main thread's transaction wrapper.
- Schema is created exclusively via `CREATE TABLE IF NOT EXISTS`. The only migration path is additive `ALTER TABLE … ADD COLUMN` guarded by `columnExists` — see `migrateCursorVacuumColumns` which adds `last_seen_size_bytes` and `last_seen_page_count` to existing `source_cursors` rows.

## Tables

| Table | Purpose | Primary key | Cleared by |
| --- | --- | --- | --- |
| `upload_batches` | Pending + failed batches. `body` is the zstd-compressed-then-base64-encoded payload. | `capture_id` (UUIDv7) | `markBatchDelivered` (per row), `pruneBuffer` (failed rows past retention), `dropOldestPending` (manual recovery). Pending rows are never time-pruned. |
| `source_cursors` | Per-source watermark. Composite PK on `(source_app, source_path_hash, source_inode, watermark_table)`. | composite | Never pruned. `setCursorFromRegression` rewrites on a 400-watermark-regression response. |
| `upload_receipts` | Proof-of-delivery for shipped batches. ~200 B/row (constant in `prune.ts`). | `capture_id` | `pruneBuffer` past `receiptRetentionDays`. |
| `buffer_metadata` | Singleton-ish KV: `capture_cycles_total`, `drain_cycles_total`, `upload_total_bytes_shipped`, `latest_known_version`, per-source ship counters. | `key` | Never pruned; values are incremented in place. |
| `daemon_state` | Singleton row (`id = 1` CHECK). Last cycle timing, last drain counters, last-error, per-source capture results as JSON. | `id = 1` | Always upserted; never deleted. |
| `quarantined_records` | Metadata-only record of oversized rows skipped during capture. Body content is **never** stored here. | autoincrement `id` | `pruneQuarantinedOlderThan` inside `pruneBuffer`. |
| `resync_events` | Logs of watermark regression events when client resyncs with the server. | autoincrement `id` | `pruneBuffer` past `receiptRetentionDays`. |

## The dedup story

- **Wire-level dedup**: server idempotency key is `capture_id` (UUIDv7, time-sortable). Re-uploading the same `capture_id` returns `{ accepted: true, idempotent: true }`; the gateway records `idempotent_on_server = 1` on the receipt row.
- **Cursor dedup**: capture only writes a batch if its computed slice extends past the existing `cursors.watermark_end`. The composite PK `(source_app, source_path_hash, source_inode, watermark_table)` lets the same file produce independent cursors after a VACUUM (`#gen-N` suffix + rehash).
- **No content-hash dedup**. The gateway does not hash batch bodies — if a source rewrites already-shipped bytes (without a VACUUM signal), capture will re-ship them. The detection contract is "monotonic watermark" only.

## Eviction & retention

- `pruneBuffer({ db, receiptRetentionDays, failedRetentionDays })` deletes in one transaction: old receipts, old failed batches, old quarantined rows, old resync events, then writes `metadata.last_prune_at`. Defaults are both 365 days.
- Pending batches are intentionally never time-pruned — the gateway promises eventual delivery. The only way to drop pending bytes without shipping is `dropOldestPending`, currently only invoked by manual recovery.
- Quarantine eviction shares the `failedRetentionDays` cutoff (treated as the same "obsolete" budget).

## Pressure & soft-pause

- `checkPendingPressure({ db, softPauseBytes, softResumeBytes })` returns `{ pendingBytes, shouldPause, shouldResume }`. Measurement is `SUM(LENGTH(body))` over `status = 'pending'` rows only — not WAL, not indexes, not failed/quarantined.
- Defaults: pause at 50 GiB, resume at 45 GiB (see `config.constants.ts`). Hysteresis is enforced by `validateAndCoerce` (`resume < pause`).
- Capture cycle writes `BUFFER_FULL` sentinel when `shouldPause`; drain cycle clears it when `shouldResume`. This asymmetry is load-bearing.

## VACUUM detection

- `detectVacuum(signals)` (in `vacuum-detect.ts`) is pure and stateless. Inputs: prior cursor's `lastSeenSizeBytes` + `lastSeenPageCount` + `watermarkEnd`, current sqlite `size_bytes` + `page_count` + `max_rowid`.
- Returns vacuumed-true on any of: `size_decreased`, `page_count_decreased`, `rowid_regressed` (`currentMaxRowid + 1 < cursorWatermarkEnd`). Source-side `collect.ts` consumes the result to bump `#gen-N` on the source path.
- This helper is for **source** sqlite files (Cursor `state.vscdb`, Codex `state_*.sqlite`). The gateway never `VACUUM`s its own `buffer.db`.

## Lifecycle

- Daemon bootstrap calls `openBufferDb(capture.bufferPath)` once. The DB handle is threaded into every cycle context.
- Capture cycle reads via `query`, writes via the worker → main-thread transactional commit (see `capture-cycle.ts:303-344`).
- Drain cycle reads via `nextPendingBatch` / `nextPendingBatchAfter` (cursor pagination by `(createdAt, captureId)`), then `markBatchDelivered` (insert receipt + delete batch in one tx) or `recordRetriableFailure` (attempts++ + lastError), or `markBatchFailed` (status='failed' + lastError + attempts++).
- Heartbeat cycle only touches metadata (`last_version_check_at`, `latest_known_version`).
- Shutdown: there is no explicit close. The process exit closes the file handle; WAL checkpoint is left to bun:sqlite defaults.

[source: src/services/buffer/db.ts:23-59; src/services/buffer/buffer.constants.ts:8-15,130-252; src/services/buffer/batches.ts:111-196; src/services/buffer/prune.ts:58-119; src/services/buffer/pressure.ts:17-24; src/services/buffer/vacuum-detect.ts:17-28; src/services/buffer/quarantine.ts:35-63]
