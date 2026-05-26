# Observability Events

- Log file: `<logDir>/structured.<YYYY-MM-DD>.1.log`. Rotated daily via pino-roll. Retention: 90 days, 5 GiB total cap. Mode `0o600` on POSIX.
- `capture.cycle.start` / `capture.cycle.complete` (INFO): `started_at`, `duration_ms`. A skipped cycle emits `capture.cycle.skipped` with `reason` (auth_failed | paused | buffer_full).
- `source.poll.complete` (INFO): `source_app`, `files_processed`, `captured_batches`, `captured_bytes`, `errors_count`.
- `drain.complete` (INFO): `attempted`, `accepted`, `retriable`, `fatal`, `recovered`, `retry_after_ms`.
- `upload.fatal` (ERROR): `capture_id`, `kind`, `error`, `source_path_hash`, `compressed_bytes`, `watermark_start`, `watermark_end`, HTTP context.
- `buffer.soft_pause` (WARN): `pending_bytes`, `threshold`. Emitted on every capture tick while pressure persists.
- `buffer.prune` (INFO): `receipts_deleted`, `failed_batches_deleted`, `quarantined_deleted`, byte freed counts.
- `auth.invalid` (FATAL): `reason`, `capture_id`. Sentinel written on same event.
- `vacuum.detected` (varies): `source_path`, `reason` (size_decreased / page_count_decreased / rowid_regressed).
- `stale_binary.paused` (WARN): `days_since_install`, `pause_after_days`.
- Exit codes: 0 ok, 1 error, 2 validationError, 3 authError, 4 notInstalled, 5 alreadyInstalled, 7 fileUnreadable, 130 userAborted. 6 intentionally skipped.
- `tail` filter flags compose with AND: `--level`, `--source`, `--since`, `--lines`, `--follow`, `--raw`. Mid-follow midnight rollover handled automatically (position reset to 0).
- `inspect` command: dry-run, no buffer writes, uses same Bun Workers. Reports saved to `tmp/proxai-gateway/reports/inspect_<timestamp>.md`.
