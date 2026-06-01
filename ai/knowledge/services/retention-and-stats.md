# Retention and Stats

Documents the data model for `upload_receipts`, `resync_events`, the derive-from-rows statistics approach, prompt extraction, and failure retention.

## Receipt lifecycle

`upload_batches` is the work queue — it holds the full compressed body blob while pending. On successful delivery, `markBatchDelivered` (in `src/services/buffer/batches.ts`) inserts a lean `upload_receipts` row and deletes the batch. The body (prompt + responses) is destroyed at delivery, but a redacted user prompt is retained in the receipt.

## upload_receipts schema (extended)

Required columns (NOT NULL — drive dedup/watermark/delivery):
- `capture_id` (PK, UUIDv7)
- `source_app`
- `source_path_hash`
- `watermark_kind`
- `watermark_start`
- `watermark_end`
- `delivered_at`
- `idempotent_on_server`

New nullable columns (all added via `ALTER TABLE ... ADD COLUMN` with `columnExists` guard; pre-upgrade rows will have NULL for all — all consumers must degrade gracefully):

| Column | Type | Purpose |
| --- | --- | --- |
| `user_prompt` | TEXT | User's (redacted) prompt, extracted at delivery. Per-source parsing; responses/outputs stripped. `logs` display payload. |
| `user_prompt_added_at` | TEXT | When the user submitted the prompt, extracted from the body (true activity time, more accurate than `captured_at_utc` for display). |
| `source_path` | TEXT | Raw absolute source path. Dev/doctor only — privacy-sensitive, NOT shown to prod users. |
| `agent_schema_version` | TEXT | Parser schema version that produced the record. |
| `gateway_version` | TEXT | CalVer of the gateway that shipped the record. |
| `captured_at_utc` | TEXT | Gateway ingest time. |
| `attempts` | INTEGER | Upload attempts before success. |
| `source_inode` | INTEGER | Rename/vacuum detection aid. |
| `shipped_bytes` | INTEGER | Compressed size shipped. Used to derive uploaded-bytes stats (SUM). Nullable; null rows don't contribute to the SUM. |

Naming rationale: `user_prompt` (not `redacted_prompt` — redaction is a pipeline invariant; the name doesn't need to carry it). `user_prompt_added_at` (not `prompt_at_utc` — captures the user-activity timestamp).

## resync_events table

Tracks watermark-regression recoveries (the `setCursorFromRegression` path). Every time the server is ahead of the local cursor and the gateway fast-forwards to match, a row is inserted:

| Column | Type | Notes |
| --- | --- | --- |
| `source_app` | TEXT | |
| `source_path_hash` | TEXT | |
| `watermark_kind` | TEXT | |
| `server_watermark_end` | INTEGER | Where the server was |
| `skipped_units` | INTEGER | `server_watermark − gateway_watermark` (units skipped) |
| `recovered_at` | TEXT | ISO-8601 timestamp |

This table feeds:
- `status` "re-synced with server" informational line.
- `doctor` scenario G3 (regression loop: many rows for one `source_path_hash` in a short window = stale backup / duplicate-host / vacuum storm).

`skipped_units` is in source bytes/rowids, NOT compressed-uploaded bytes — do not mix into byte totals.

## Retention periods

| Data | Retention |
| --- | --- |
| `upload_receipts` (metadata + prompt) | 1 year (365 days) |
| `resync_events` | 1 year |
| `upload_batches` (failed) | 1 year (body retained until pruned — allows `logs --error` body inspection) |
| `upload_batches` (pending) | Never time-pruned — stays until shipped or explicitly dropped |
| `quarantined_records` | Pruned with failed batches (1 year) |
| `buffer_metadata` last-event markers | Permanent (single-row overwrite per key; no counter drift) |

`uninstall --reset` wipes the entire `configDir` tree, clearing everything.

## Derive-from-rows statistics (Option 1)

All cumulative stats are derived from table rows at read time. There are no drifting counters.

**Dropped forever:** `drain_total_batches_shipped`, per-source totals, `cycles_total`, and other `buffer_metadata` counters. These silently drifted behind the authoritative rows.

**What survives in `buffer_metadata` (last-event markers only):**
- `capture_last_cycle_at`
- `drain_last_cycle_at`
- `last_version_check_at`
- `latest_known_version`
- `last_prune_at`

**Derived at read time:**
- Records uploaded (12mo window) = `COUNT(*)` over `upload_receipts`
- Bytes uploaded (12mo) = `SUM(shipped_bytes)` over `upload_receipts`
- Per-source = `… GROUP BY source_app`
- Last success = `MAX(delivered_at)`
- Pending / failed = `COUNT`/`SUM` over `upload_batches`
- Quarantined = `COUNT` over `quarantined_records`
- Idempotent re-sends = `COUNT WHERE idempotent_on_server = 1`

**Captured-vs-uploaded formula:**
```
captured = SUM(receipts.shipped_bytes) + pending body bytes + failed body bytes
uploaded = SUM(receipts.shipped_bytes)
captured − uploaded = pending + failed
```
These match exactly when caught up; pending/failed are the only honest divergence explainers.

**Idempotent receipts counted in BOTH captured and uploaded** (by design — they are real bytes the gateway shipped; a "N re-sent duplicates" footnote may appear separately but does not distort totals).

Window label: "last 12 months" — never "all time" (receipts are pruned at 1 year).

## Prompt extraction at delivery

Per-source extraction happens inside `markBatchDelivered` (or a helper called from there): decompress the batch body, parse the JSONL, apply per-source logic to extract the user's prompt turn and timestamp, strip responses/tool outputs. Write result to `user_prompt` and `user_prompt_added_at` on the receipt row.

Extraction is **fault-tolerant**: any parse failure, missing field, or unknown source shape → `null`. The delivery never throws into the upload path on a prompt-extraction failure. Redaction has already been applied to the body before upload; extracted prompts are already redacted.

Per-source boundaries (user turn vs assistant turn vs tool output):
- `claude-code`: `type === 'user'` turns in JSONL `message` arrays.
- `cursor`: SQL KV pairs with the user's prompt key.
- `codex`: equivalent per-source parsing; specific field paths defined in each source's parser.

## Display tiers

| Tier | Shown in | Columns visible |
| --- | --- | --- |
| USER | prod `logs`, `status` last-N | `user_prompt_added_at`, `source_app`, `user_prompt` snippet, `shipped_bytes` |
| DEV | dev-mode `logs`, `logs --profile dev` | All receipt columns |
| DOCTOR | `doctor` signal appendix | `agent_schema_version`, `gateway_version`, `attempts`, `captured_at_utc` vs `delivered_at`, `source_path`, `source_inode` |

`source_path` is **never** shown to prod users — it is privacy-sensitive and dev/doctor-only.

[source: src/services/buffer/batches.ts; src/services/buffer/db.ts; src/services/buffer/prune.ts; src/services/buffer/receipts.ts; src/services/uploader/upload-batch.ts; src/services/buffer/index.ts]
