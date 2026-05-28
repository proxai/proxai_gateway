# Data-Model and Stats — Implementation Plan

> **STATUS: DONE** (commits `c709a0d`–`1c9a6dc`, 2026-05-27/28). All items in this plan have landed. Read this plan for context only; do not re-implement anything here.
>
> **Source of truth:** `../decisions/02-commands-and-retention.md` (resolved decisions section) and `../decisions/03-doctor-scenarios.md`.

This plan implements the data-model changes that underpin the `doctor` command, the `logs` command, the redesigned `status`, and the "indicators stuck at zero" fix. All schema changes are **additive** — `ALTER TABLE … ADD COLUMN` guarded by `columnExists`, no migration framework, no `PRAGMA user_version`. Pre-upgrade rows have NULL for all new columns; every consumer must degrade gracefully on NULL.

---

## Context: why this is its own workstream

Phase 2 was originally conceived to include retention/stats changes alongside the dual-daemon machinery. Those concerns are independent: the receipt schema and derive-from-rows stats do not require two daemons, a command restructure, or even `ProfileContext` threading. Decoupling them lets them land sooner and unblocks `doctor`/`logs`/`status` work without waiting for the full Phase 2 command surface.

---

## 1. Extend `upload_receipts`

**Hard principle (user, 2026-05-27):** only fields essential to operations are `NOT NULL`; every other field is nullable. Null values must render as empty in logs/doctor/status and never crash the app.

### Existing NOT NULL columns (unchanged)

`capture_id` (PK), `source_app`, `source_path_hash`, `watermark_kind`, `watermark_start`, `watermark_end`, `delivered_at`, `idempotent_on_server`. (`watermark_table` is already nullable.)

### New nullable columns (LOCKED 2026-05-27)

Add each via `ALTER TABLE upload_receipts ADD COLUMN … DEFAULT NULL` guarded by `columnExists`:

| Column | Type | Purpose |
| --- | --- | --- |
| `user_prompt` | TEXT | User's redacted prompt text, option-A extraction at delivery. Display payload for `logs`/`status`. Responses/assistant turns stripped — user-turn only, already redacted (redaction is a pipeline invariant). |
| `user_prompt_added_at` | TEXT | ISO timestamp when the user submitted the prompt, extracted from the body. True activity time — more accurate than `captured_at_utc` for user-facing "when". |
| `source_path` | TEXT | Raw absolute source path. Dev/doctor-only display (privacy-sensitive; never shown to prod users). |
| `agent_schema_version` | TEXT | Parser provenance. Used by doctor to correlate failing records to a parser version. |
| `gateway_version` | TEXT | CalVer that shipped this batch. Provenance for debugging. |
| `captured_at_utc` | TEXT | ISO timestamp when the gateway captured (ingested) the data. |
| `attempts` | INTEGER | Upload attempts before success. Doctor uses this to detect retry pressure (scenario C6). |
| `source_inode` | INTEGER | Inode at capture time. Doctor uses this alongside rename/vacuum detection (scenario G3). |
| `shipped_bytes` | INTEGER | Compressed bytes sent to the server for this batch. **Required for derive-from-rows stats** (`SUM(shipped_bytes)` = bytes uploaded). Still nullable per the principle; NULL rows contribute 0 to SUM. |

### Implementation notes

- Add columns in `src/services/buffer/db.ts` alongside the existing `migrateCursorVacuumColumns` pattern.
- `markBatchDelivered` (in `src/services/buffer/batches.ts`) is where the receipt row is inserted. Extended its `DeliveredBatchMeta` input type to carry the new nullable fields. Callers (in `src/services/uploader/upload-batch.ts`) extract and pass them.
- `shipped_bytes` is available from the batch body length at send time — the uploader already has access to it.
- `gateway_version` is available from `package.json` version (already read in other places via a version helper).
- `captured_at_utc` is the `captured_at` timestamp on the `upload_batches` row — copied to the receipt on delivery.
- `attempts` is the upload retry count, tracked in the uploader loop.
- `source_inode` comes from the cursor row (`source_cursors.last_seen_inode`) — joined or passed through to the receipt.

**Committed:** `c709a0d` (`feat: extend upload_receipts with nullable display+debug columns`) + `e9c6d11` (`feat: populate receipt debug columns at delivery`)

---

## 2. Add `resync_events` table

New table to record watermark-regression recoveries. Purpose: make re-sync events visible in `status` and give `doctor` its G3 (regression-loop) signal.

```sql
CREATE TABLE IF NOT EXISTS resync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_app TEXT NOT NULL,
  source_path_hash TEXT NOT NULL,
  watermark_kind TEXT NOT NULL,
  server_watermark_end INTEGER NOT NULL,
  skipped_units INTEGER NOT NULL,
  recovered_at TEXT NOT NULL
);
```

`skipped_units` = `server_watermark_end − local_watermark_end_before_regression` (how far the cursor fast-forwarded past data the server already had). Units are source-specific (byte offset for `byte_range` watermarks, rowid for `rowid_range` watermarks).

### Write path

In `src/services/uploader/upload-batch.ts`, inside the `recovered` outcome branch (after `setCursorFromRegression` + `deleteBatch`), insert a `resync_events` row. This is the only writer.

The insert goes through the buffer API (`services/buffer/index.ts` barrel) — `recordResyncEvent(db, event)` function added in `services/buffer/`.

### Read path

`status` query: `SELECT COUNT(*), MAX(recovered_at) FROM resync_events` → "re-synced with server: N sources, last at TIME" shown as an informational note.

Doctor scenario G3: `SELECT COUNT(*), MIN(recovered_at) FROM resync_events WHERE source_path_hash = ? AND recovered_at > datetime('now', '-1 hour')` → many re-syncs in a short window = stale-backup loop / dual-host / vacuum storm.

### Retention

Prune alongside receipts at 1 year. Added to `pruneBuffer` in `src/services/buffer/prune.ts`.

**Committed:** `45f8a5f` (`feat: add resync_events table for watermark-regression visibility`) + `fc22bc0` (`feat: record resync events on watermark regression recovery`)

---

## 3. Retention changes

### Receipt retention: 30 days → 365 days

Changed `receiptRetentionDays` default in `src/services/config/config.constants.ts` from `30` to `365`.

### Failed-batch retention: 30 days → ~365 days

Changed `failedRetentionDays` default to `365`. Rationale: keep failed batches longer to give `doctor` more signal, and to allow re-inspection of records that were lost.

### `uninstall --reset` still wipes immediately

No change to `--reset` behavior. The 1-year retention is the no-action default; `--reset` is the nuclear option.

### `resync_events` retention: 365 days

Pruned by `pruneBuffer`.

**Committed:** `8f49a96` (`feat: retain receipts, failed, resync events for one year`)

---

## 4. Derive-from-rows statistics (Option 1)

**Replace** the cumulative `buffer_metadata` counter approach with queries derived from rows at read time. This eliminates the drift-prone read-modify-write counters that caused the "indicators stuck at zero" bug.

### Drop cumulative counters from `buffer_metadata`

The following `buffer_metadata` rows removed from the write path (no longer set or read):

- `drain_total_batches_shipped`
- Per-source shipped totals
- `cycles_total` (or equivalent)

These were TEXT-stored integers updated in a swallow-on-error try/catch outside the delivery transaction, making them chronically stale.

### Counters replaced by queries (computed at read time)

| What | Query |
| --- | --- |
| Records uploaded (12-month window) | `SELECT COUNT(*) FROM upload_receipts WHERE delivered_at > datetime('now', '-365 days')` |
| Bytes uploaded (12-month window) | `SELECT COALESCE(SUM(shipped_bytes), 0) FROM upload_receipts WHERE delivered_at > datetime('now', '-365 days') AND shipped_bytes IS NOT NULL` |
| Per-source breakdown | `… GROUP BY source_app` |
| Last successful upload | `SELECT MAX(delivered_at) FROM upload_receipts` |
| Pending count / bytes | `SELECT COUNT(*), COALESCE(SUM(LENGTH(body)), 0) FROM upload_batches WHERE status = 'pending'` (unchanged) |
| Failed count | `SELECT COUNT(*) FROM upload_batches WHERE status = 'failed'` (unchanged) |
| Quarantined count | `SELECT COUNT(*) FROM quarantined_records` (unchanged) |
| Re-sync events | `SELECT COUNT(*), MAX(recovered_at) FROM resync_events` |

### Keep only last-event markers in `buffer_metadata`

Single-row overwrite values; no drift by construction:

- `capture_last_cycle_at`
- `drain_last_cycle_at`
- `last_version_check_at`
- `latest_known_version`
- `last_prune_at`

These are already single-write overwrites; kept as-is.

### Idempotent receipts are counted in BOTH captured and uploaded

User confirmed 2026-05-27. `idempotent_on_server = 1` rows are not excluded from the SUM. They are real bytes the gateway shipped. A cheap footnote may show "(N re-sent duplicates)" via `COUNT WHERE idempotent_on_server = 1`, but it usually reads ~0.

### Captured vs uploaded (the healthy-match formula)

```
captured_bytes = SUM(upload_receipts.shipped_bytes) + pending_body_bytes + failed_body_bytes
uploaded_bytes = SUM(upload_receipts.shipped_bytes)
```

When fully caught up: `captured − uploaded = 0`. Pending and failed are the only honest divergence explainers. `status` shows "X MiB captured, Y MiB uploaded, Z MiB pending" where `X = Y + Z` when healthy.

### Performance

Local SQLite COUNT/SUM over ≤1 year of rows is ms-scale for any realistic user. If a power user accumulates extreme row counts, add a covering index: `CREATE INDEX IF NOT EXISTS idx_receipts_delivered_app ON upload_receipts (source_app, delivered_at, shipped_bytes)`. Not needed by default.

Label the window honestly in UI output: "last 12 months", not "all time".

**Committed:** `3f0b82a` (`feat: derive upload statistics from rows, drop drift-prone counters`)

---

## 5. Per-source prompt extraction (Option A)

At delivery time, extract the user's prompt from the batch body. Option A: implement extraction per source parser in the gateway, at the moment `markBatchDelivered` is called.

### What to extract

- **Keep:** the user's most recent prompt/request (the human turn).
- **Drop:** source-app responses, assistant turns, tool outputs, tool results.
- The extracted text has already been redacted by the redaction pipeline before the body was stored. Do not re-redact; use the text as-is.

### Per-source extraction logic

Each source stores conversation turns differently. The extraction runs on the decompressed-and-decoded body text (the same `redacted_text` that was base64(zstd)-compressed into `body`). The uploader decompresses the body at delivery to extract the prompt before inserting the receipt.

| Source | User-turn identification |
| --- | --- |
| `claude-code` | JSONL records with `type: 'user'` and `message.role === 'user'`; take the last such record's content text. |
| `gemini-cli` | The conversation format has explicit `role: 'user'` turns; take the last user-role message text. |
| `cursor` | KV pairs include a conversation blob; identify user turns by role field. |
| `codex` | State file conversation contains user messages; extract by role. |

For sources where extraction is uncertain or the format is not yet fully understood, the `user_prompt` column stays NULL rather than storing a bad extraction. A NULL is always safe; a wrong extraction is misleading.

### Where the extraction runs

In `src/services/uploader/upload-batch.ts`, inside the `accepted` outcome branch, after the HTTP 200 response. At this point the raw (compressed) body is still available from the `upload_batches` row. Steps:

1. Decompress `body` (zstd decompress + base64 decode → raw JSONL/text).
2. Parse turns for the batch's `source_app`.
3. Take the last user turn's text (truncated to a display limit, e.g., 500 chars, to bound receipt row size).
4. Pass `userPrompt: string | null` and `userPromptAddedAt: string | null` into `markBatchDelivered`.

The decompression is bounded — `upload_batches.body` already went through the oversized-slice quarantine (>10 MiB decompressed is quarantined before upload). At delivery, the decompressed size is known safe.

### Failure handling

Prompt extraction must never cause a delivery to fail. Wrap in try/catch; on any error, pass `userPrompt: null`. The batch is delivered regardless.

**Committed:** `1c9a6dc` (`feat: add per-source user-prompt extractor; wire into delivery path`)

---

## 6. Doctor's dependency on these tables

The `doctor` command (Phase 2, now DONE) derives its signals from these tables. Key dependencies:

| Doctor scenario | Table / column used |
| --- | --- |
| G1 — counter vs table mismatch | Compares old `buffer_metadata` counter (if still present) against `COUNT(*) FROM upload_receipts`; after this workstream the counter is gone so G1 becomes "table is readable and has rows" |
| G2 — buffer.db corrupt | SQLite open / integrity check against `upload_receipts` and `resync_events` |
| G3 — regression loop | `resync_events WHERE source_path_hash = ? AND recovered_at > datetime('now', '-1 hour')` |
| C6 — parser emitting ValidationErrors | `upload_batches WHERE status = 'failed'` cross-checked with `agent_schema_version` from `upload_receipts` |
| A5 — wedged daemon | `capture_last_cycle_at`, `drain_last_cycle_at` from `buffer_metadata` |

Doctor is a read-only consumer. It never writes to any table.

---

## Implementation order (completed)

1. **Add receipt columns** (`c709a0d`) — `src/services/buffer/db.ts` migration + `DeliveredBatchMeta` type extension.
2. **Add `resync_events` table** (`45f8a5f`) — DDL in `db.ts` + `recordResyncEvent` buffer API function.
3. **Bump retention defaults** (`8f49a96`) — `config.constants.ts`. Updated affected tests.
4. **Extend `markBatchDelivered`** (`e9c6d11`) — threaded new fields from uploader. Passed `shipped_bytes`, `gateway_version`, `captured_at_utc`, `attempts`, `source_inode` first.
5. **Write `resync_events` in the `recovered` outcome path** (`fc22bc0`) — `upload-batch.ts`.
6. **Drop cumulative counter writes** (`3f0b82a`) — removed `buffer_metadata` counter updates from drain cycle. Updated `pruneBuffer`. Updated `status` query layer to use derived stats.
7. **Per-source prompt extraction (Option A)** (`1c9a6dc`) — added extraction helpers per source, wired into `markBatchDelivered`.
8. **`resync_events` pruning** — included in `8f49a96`.
