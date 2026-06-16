---
name: "Buffer Database Schema and Operations"
description: "Additive-only schema rules, WAL settings, delivery/prune transactions, Soft Pause thresholds, and permissions."
activation: "contextual"
scenarios: ["Modifying buffer.db database schema", "Updating soft-pause or soft-resume threshold behaviors", "Implementing metadata, quarantine, or transaction operations"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Buffer Schema Rules


- All schema DDL is `CREATE TABLE IF NOT EXISTS`. Schema changes must be additive (new columns via `ALTER TABLE … ADD COLUMN`, guarded by `columnExists`). There is no migration framework and no down-migration path.
- Buffer open settings are fixed: `WAL` + `synchronous = NORMAL` + `foreign_keys = ON`. Do not alter these pragmas.
- `markBatchDelivered` (insert receipt + delete batch) and `pruneBuffer` (delete old receipts, failed, quarantined, resync_events + update metadata) each run inside one `db.transaction(...)`. Do not split them.
- Pending batches are never pruned by time — only shipped batches (receipts) and failed batches are pruned. Pending rows stay until shipped or explicitly dropped.
- The quarantined-records table stores metadata only (never the body content). `recordQuarantine` is called for oversized rows; the cursor advances past the quarantined rowid so the cycle keeps making progress.
- Buffer pressure is measured as `SUM(LENGTH(body))` over pending batches only (not WAL, not indexes). The default soft-pause threshold is **50 GiB** and soft-resume is **45 GiB** (source of truth: `config.constants.ts` — the docs say 700 MiB / 600 MiB but those are stale). The existing `ai/knowledge/architecture/overview.md` already documents this mismatch.
- Never `VACUUM` `buffer.db`. (The `detectVacuum` helper detects `VACUUM` on source sqlite files, not on the buffer.)
- `buffer.db` permissions are `0o600` (enforced via `chmod` after open on POSIX). Skip the chmod call on Windows.
