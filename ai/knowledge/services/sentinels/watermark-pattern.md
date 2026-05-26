# Watermark Pattern

A **watermark** is a monotonically advancing scalar that records how much of
a source file the gateway has captured. Watermarks are the gateway's
only durable mechanism for resuming after a restart, deduplicating across
captures, and recovering from server-side regression.

## The two watermark kinds

From `services/contract/contract.types.ts:9-25`:

- `byte_range` — for append-only JSONL files. `start` and `end` are byte
  offsets into the file. `table` is always `null`. Used by claude-code,
  codex rollouts, gemini-cli.
- `rowid_range` — for sqlite-backed sources. `start` and `end` are
  sqlite `rowid` values + 1 (exclusive upper bound). `table` is `null`
  for cursor (kv-snapshot) and a string for codex state
  (`threads` / `thread_dynamic_tools` / `thread_spawn_edges`).

## On-disk shape (source_cursors)

`source_cursors` row keys are `(source_app, source_path_hash, source_inode,
watermark_table)`. The `watermark_end` column is the resume point — the
next capture starts at `watermark_end`. Buffer DDL:
`buffer.constants.ts:165-184`.

Two sentinels in the key absorb nullable fields cleanly:
- `NO_INODE_SENTINEL = 0` for sources without inode tracking
- `NO_TABLE_SENTINEL = ''` for sources without a watermark table

The `setCursor` UPSERT (`buffer/cursors.ts:35-60`) is the single write
chokepoint. It updates `watermark_end`, `last_polled_at`,
`consecutive_errors`, and the two `last_seen_*` columns used for VACUUM
detection (`vacuum-detect.ts`).

## Monotonicity contract

`watermark_end` must **only move forward**. Three places must hold this
invariant:

1. **Per-source collect** — every `collect.ts` advances `watermark_end`
   to the new exclusive upper bound on success; on error, the catch
   block writes the **prior** `watermark_end` with `consecutiveErrors:
   priorErrors + 1`. The source never regresses on its own.
2. **DTO validation** — `validate.ts:109-111` rejects
   `start >= end`. A batch with degenerate watermark cannot be uploaded.
3. **Server-side** — the backend's BullMQ ingest job rejects any batch
   whose `watermark_end` is less than the server's stored value for that
   `(source_app, source_path_hash, watermark_table)` triple.

When (3) fires, the server returns HTTP 400 with body:

```json
{
  "error": "watermark_regression",
  "current_server_watermark_end": <number>,
  "source_path_hash": "<hex>"
}
```

(parsed by `services/http/parse-helpers.ts:3-21`)

## The watermark-regression handshake

`upload-batch.ts:57-69` handles `WatermarkRegressionError`:

```
setCursorFromRegression(ctx.db, batch, err.currentServerWatermarkEnd);
deleteBatch(ctx.db, captureId);
return { kind: 'recovered', captureId };
```

`setCursorFromRegression` (`buffer/cursors.ts:121-149`) preserves the
prior `lastSeenSize/PageCount` (so VACUUM detection doesn't false-fire)
and overwrites only `watermark_end`. The batch is **deleted**, not
marked failed — it's redundant data, not bad data.

Outcome `recovered` is one of the four `UploadOutcome.kind` values
(`accepted` | `fatal` | `recovered` | `retriable`). It's accounted
separately in metrics and does not count toward retriable backoff.

When this fires: the daemon was uninstalled/reinstalled with a fresh
`buffer.db` but the server remembers; or another daemon on a different
host with the same `source_path_hash` already shipped the data; or the
buffer DB was restored from a stale backup. In all cases, the server's
watermark is authoritative.

## Initial-state seeding (the inverse handshake)

`syncServerWatermarks` (`polling/watermark-sync.ts:19-54`) is called on
daemon startup when the local `source_cursors` table is empty for a
given source. It hits `GET /v1/watermarks`, filters out unknown
`source_app` values, and seeds cursors via `setCursor` with `sourcePath:
''`. The empty path is a placeholder — the next discovery cycle will
populate the real path during its first poll.

## Cross-capture progress

Within a single source-file capture cycle, watermarks advance once per
batch insertion:
1. Read prior `watermarkEnd` from the cursor.
2. Read source content from `[watermarkEnd, newEnd)`.
3. Apply filter, redact, compress, split.
4. For each split batch, `insertBatch` with `watermark_start, watermark_end`
   covering its byte/rowid range.
5. After all batches inserted in the transaction, `setCursor` with the
   final `watermarkEnd` (the highest split's `end`).

The split semantics matter: a single source slice may produce multiple
batches with adjacent watermark ranges (`[0, 1000)`, `[1000, 2000)`, ...).
Each batch's `watermark_end` is committed independently to the server,
but the cursor only moves once after the whole slice is buffered. A
mid-slice daemon crash leaves the cursor at the prior position and
re-captures the slice — `capture_id` is regenerated, so duplicate
batches reach the server with **different** idempotency keys but
**overlapping** watermark ranges. The server-side check on
`watermark_end` deduplicates: the second batch in the overlapping pair
gets `watermark_regression` and the daemon recovers.

[source: src/services/contract/contract.types.ts, src/services/contract/validate.ts, src/services/buffer/cursors.ts, src/services/buffer/buffer.constants.ts, src/services/uploader/upload-batch.ts, src/services/http/parse-helpers.ts, src/services/polling/watermark-sync.ts]
