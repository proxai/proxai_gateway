# Audit: Crash Recovery Semantics for Cursor Advancement

Audit-only. No code changes proposed in this document.

## 1. Current Behavior

The local source cursor advances **immediately after the batch is inserted into
the buffer**, *not* after server-accept. Every poller follows the same pattern:

| Poller | File | Lines |
| --- | --- | --- |
| claude-code | `src/sources/claude-code/collect.ts` | `insertBatch` at L74, `setCursor` at L76–83 |
| cursor | `src/sources/cursor/collect.ts` | `insertBatch` at L107, `setCursor` at L109–116 |
| codex (rollout) | `src/sources/codex/collect-rollout.ts` | `insertBatch` at L71, `setCursor` at L73–80 |
| codex (state) | `src/sources/codex/collect-state.ts` | `insertBatch` at L148, `setCursor` at L150–157 |

Both calls are unconditional and live next to each other in the same try block.
`insertBatch` is implemented in `src/services/buffer/batches.ts` (L102–122) as
a single SQL `INSERT` against `upload_batches`. `setCursor`
(`src/services/buffer/cursors.ts` L67–78) is a single `INSERT … ON CONFLICT
DO UPDATE` against `cursors`. **Neither call is wrapped in a SQLite
transaction**: each runs as its own auto-committed statement.

The uploader (`src/services/uploader/upload-batch.ts`) does not advance the
local cursor on accept; it only mutates the cursor when the server returns the
structured `watermark_regression` 400 response — see
`setCursorFromRegression` at L61, which rewinds the cursor to the server's
authoritative watermark and discards the duplicate batch.

## 2. Design Rationale: Advance on Capture-into-Buffer

The current design is deliberate. It optimizes for two properties:

1. **Files on disk are not re-read.** Once bytes have been read from a JSONL
   rollout (or a SQLite snapshot has been taken and rows extracted), the bytes
   are persisted into the local buffer DB. The bytes have already been
   compressed (zstd) and run through redaction. Re-reading the source file
   means re-paying the I/O, decode, redaction, and compression cost. It also
   widens the window during which on-disk files might mutate (rotated,
   truncated, or vacuum'd by the source application) underneath the gateway.
2. **No capture_id explosion.** Each batch carries a unique `capture_id`
   (UUIDv7). Re-reading the same byte range and producing a fresh capture_id
   each cycle would fan out into many capture_ids representing the same
   underlying record. The server contract (Nest ingest) deduplicates on
   `(host_id, source_path_hash, watermark_kind, watermark_start, watermark_end,
   watermark_table)` — so duplicates are detected — but the dedup table grows
   linearly with the duplication factor and forces extra work on the server
   per cycle. Advancing on insert keeps the capture_id-to-byte-range mapping
   1:1.

Net effect: the local buffer DB is the source of truth for "what has been
captured." The server is the source of truth for "what has been delivered."
Recovery is partitioned cleanly between the two.

## 3. Alternative Design: Advance on Server-Accept

An alternative would be to defer `setCursor` until the uploader receives an
HTTP 200 from the ingest endpoint. The change would live in
`src/services/uploader/upload-batch.ts`: on the `accepted` outcome, write the
cursor (in addition to the receipt) before deleting the batch row.

Issues this introduces:

- **Duplicate captures during outages.** If the server is unavailable for an
  extended window, the buffer fills with pending batches but the source
  cursors stay at the last successful upload. Each poll cycle re-reads the
  same bytes from disk, producing a new pending batch with a new capture_id.
  The local buffer balloons; the buffer eviction policy kicks in (oldest
  pending dropped) and earlier captures are lost without ever being
  acknowledged.
- **Capture_id explosion / dedup load.** Every duplicate read produces a fresh
  capture_id. When the server comes back online, it sees N capture_ids for
  the same byte range and idempotently rejects all but one. The work-per-byte
  ratio degrades with outage duration. Buffer churn also wastes disk and
  SQLite WAL bandwidth.
- **File-mutation race widens.** The longer the gap between read and cursor
  advance, the more opportunities for the source file to rotate, truncate, or
  be vacuum'd. The gateway would have to re-validate every read against the
  current file's inode and size before re-issuing — extra logic the current
  design avoids.
- **Crash semantics get *worse*, not better.** A crash between the
  acknowledged upload and the deferred `setCursor` write produces exactly the
  same duplicate capture_id we were trying to avoid in the first place — just
  shifted to a different failure window.

## 4. Findings

### 4.1 `insertBatch` and `setCursor` are not transactional

Confirmed by reading the four collectors and the buffer module. Each pair runs
as two adjacent auto-committed statements. There is no `db.transaction()`
wrapping them.

**Crash window.** If the gateway crashes after `insertBatch` returns but
before `setCursor` returns:

- `upload_batches` contains a row for the new range.
- `cursors` does not yet reflect the advance.

On restart, the next poll cycle re-reads from the *previous* watermark, which
overlaps with the in-buffer batch. The collector produces a *second* batch
covering the same byte range with a *new* capture_id. Both eventually upload;
the server detects the duplicate via its dedup contract and idempotently
rejects the second.

**Concrete consequences.**
- One extra HTTP roundtrip per affected batch on the recovery cycle.
- Two `capture_ids` for one byte range in the receipts table for that cycle.
- No data loss, no incorrect aggregation on the server side (dedup is exact).
- No drift: the cursor still ends up at the correct end byte after either
  upload completes (the receipt-driven dedup logic catches this).

This is the documented and intended recovery semantic. It is consistent with
the rationale in section 2.

### 4.2 The atomicity contract is implicit

Nothing in the codebase explicitly documents that `insertBatch` + `setCursor`
do not need to be atomic. The crash semantic above relies on:

1. SQLite WAL durability (each statement is committed before returning) —
   guaranteed by `PRAGMA journal_mode = WAL` and `synchronous = NORMAL`
   (`src/core/io/sqlite/open.ts`).
2. Server-side dedup on `(host_id, source_path_hash, watermark_kind,
   watermark_start, watermark_end, watermark_table)` — described in
   `planning/nest-contract.md`.

If either guarantee weakens (e.g. someone disables WAL, or the server dedup
contract changes), the audit conclusion would need to be revisited.

### 4.3 No bugs found

Behavior matches the documented design. The "duplicate batch on crash"
outcome is correct, recoverable, and bounded (at most one duplicate per
crash).

## 5. Recommendation

**Keep the current design.** Advancing the cursor on capture-into-buffer is
correct: it minimizes re-reads, prevents capture_id explosion during outages,
and produces a small, well-understood duplicate window on crash that the
existing server-side dedup absorbs cleanly.

Two optional follow-ups (not required, not bugs):

1. Wrap `insertBatch` + `setCursor` in a single `db.transaction()` per
   collector. This would close the crash window entirely (both rows commit or
   neither does) at the cost of one extra `BEGIN`/`COMMIT` per capture. Given
   the duplicate is benign and rare, this is a polish item, not a correctness
   fix.
2. Add an inline comment in each `collect.ts` next to the `insertBatch` /
   `setCursor` pair stating the implicit atomicity contract: "if a crash
   occurs between these two calls, the next cycle will re-capture the same
   range under a new capture_id; server-side dedup absorbs the duplicate."
   Documents intent for future readers.
