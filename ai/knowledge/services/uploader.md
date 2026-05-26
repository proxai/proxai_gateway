# uploader

`src/services/uploader/` is the drain orchestrator. It walks pending batches, builds the DTO, calls `HttpClient.uploadRawRecord`, and translates the response (or thrown typed error) into one of four `UploadOutcome` kinds. Retry pacing lives in `pacer.ts` (token-bucket + three independent backoff signals).

## Flow

```
drainBuffer(ctx, opts?)
  while attempted < maxBatches:
    batch = nextPendingBatch(db) | nextPendingBatchAfter(db, cursor)
    if batch === null: break
    pacer?.acquire(batch.body.byteLength)
    outcome = uploadBatch(ctx, batch)
      dto = buildRawRecordDTO(batch, hostId)
      try: http.uploadRawRecord(dto)
           markBatchDelivered(db, batch, { idempotentOnServer })
           return { kind: 'accepted', ... }
      catch err: classifyAndPersist(ctx, batch, err)
    cursor = { createdAt: batch.createdAt, captureId: batch.captureId }
    tally outcome → result
    if outcome.kind === 'retriable':
      pacer?.notify429() or pacer?.notifyServiceUnavailable(retryAfterMs?)
      pacer?.notifyRetryAfter(retryAfterMs) if set
      consecutiveRetriable++
      if consecutiveRetriable >= maxConsecutiveRetriable: break (set consecutiveRetriableBreak)
    else consecutiveRetriable = 0
```

## Defaults

| Constant | Value | Purpose |
| --- | --- | --- |
| `DEFAULT_MAX_BATCHES_PER_DRAIN` | `256` | Upper bound per drain cycle to keep latency bounded. |
| `DRAIN_MAX_CONSECUTIVE_RETRIABLE` | `3` | Three retriables in a row breaks the cycle; next 30 s tick retries. |

The cursor pagination (`nextPendingBatchAfter`) is by `(createdAt ASC, captureId ASC)` — strictly forward, monotonically. A retriable does NOT rewind to the same row; the next iteration moves to the next pending row. The failed row stays pending (or marked failed for fatals) and is picked up on a future cycle.

## `UploadOutcome` (four kinds, exhaustive)

| kind | When | Side effects on `buffer.db` | Counters |
| --- | --- | --- | --- |
| `accepted` | `http.uploadRawRecord` returned `{ accepted: true, ... }`. | `markBatchDelivered` (insert receipt + delete batch in one tx). | `accepted++`, `acceptedBytes += body.byteLength`, `acceptedBySource[app] += {batches:1, bytes}`. |
| `recovered` | `WatermarkRegressionError` (server 400 with `error: 'watermark_regression'`). | `setCursorFromRegression(db, batch, currentServerWatermarkEnd)` writes the server watermark onto the cursor row; `deleteBatch` removes the stale row. | `recovered++`. NOT marked failed. |
| `retriable` | `RateLimitError`, `RetriableError`, `NetworkError`, or `AuthError` where `verifyKey()` was inconclusive (threw a non-`AuthError`) or succeeded (transient 401). | `recordRetriableFailure(db, captureId, message)` (attempts++ + lastError). Row stays `pending`. | `retriable++`, `lastRetriableRetryAfterMs = outcome.retryAfterMs`, `lastUploadError = outcome.error`. Tells pacer to back off. |
| `fatal` | `ValidationError` (local or server 400/408/413), any other `GatewayError`, definitive auth failure (`verifyKey` returned `{ success: false }` or threw `AuthError`), or unknown exception. | `markBatchFailed(db, captureId, message)` (status='failed', attempts++, lastError). Failed rows are eligible for `pruneBuffer` after `failedRetentionDays`. | `fatal++`, `lastUploadError = error`. |

## Error classification (`classifyAndPersist`)

Order of `instanceof` checks (first match wins):

1. `WatermarkRegressionError` → `recovered`. Log `upload.watermark_recovered`.
2. `RateLimitError` → `retriable` with `reason: 'rate_limit'`. Log `upload.rate_limited` with `retry_after_ms`.
3. `AuthError` → `handleAuthError(ctx, batch, err)` — see below.
4. `RetriableError` → `retriable` with `reason: 'service_unavailable'`. Log `upload.retriable`.
5. `NetworkError` → `retriable` with `reason: 'network'` and `retryAfterMs: null`. Log `upload.retriable`.
6. `ValidationError` OR generic `GatewayError` → `fatal`. Log `upload.fatal` with `kind, source_path_hash, compressed_bytes, watermark_*` plus, for `OversizedDecompressedSliceError`, additional `raw_bytes`, `cap`, `slice_index`.
7. Anything else → `fatal` with `message: 'unknown error: <msg>'`. Log `upload.unknown_error`.

## `handleAuthError` (the AUTH_FAILED disambiguation)

A single 401/403 does not write the `AUTH_FAILED` sentinel — that would be too aggressive (transient 401s happen). Instead:

1. Call `ctx.http.verifyKey()`.
2. If `verifyKey` THREW:
   - If it threw `AuthError` → definitive failure. `finalizeAuthFailure(ctx, batch, 'verify-key threw AuthError')`.
   - If it threw anything else (`RetriableError`, `NetworkError`, …) → inconclusive. `recordRetriableFailure`, log `upload.auth_unconfirmed`, return `retriable` with `reason: 'auth_unconfirmed'`.
3. If `verifyKey` returned `{ success: false }` → definitive failure. `finalizeAuthFailure(ctx, batch, message || 'key not accepted')`.
4. If `verifyKey` returned `{ success: true }` → transient. `recordRetriableFailure`, log `upload.auth_transient`, return `retriable` with `reason: 'auth_unconfirmed'`.

`finalizeAuthFailure`: `markBatchFailed(db, captureId, 'ingestion key invalid')`, try `writeAuthFailedSentinel(path, reason)`, log `auth.invalid` (FATAL level). Returns `{ kind: 'fatal', captureId, error: 'ingestion key invalid' }`.

## DTO build (`build-dto.ts`)

`buildRawRecordDTO(batch, hostId)` is a pure transform:

- `body: Buffer.from(batch.body).toString('base64')` — base64 of the already-zstd-compressed bytes.
- `watermark` is shaped by `buildWatermark`: `byte_range` always sets `table: null`; `rowid_range` passes through `batch.watermarkTable`.
- All other fields are 1:1 from the stored batch row.

## Pacer (`pacer.ts`)

`createPacer({ maxBatchesPerSec, maxBytesPerMinute, backoffMultiplier? = 2, now?, sleep? })` returns `{ acquire, notifyRetryAfter, notify429, notifyServiceUnavailable }`. Token buckets:

| Bucket | Window | Capacity | Refill |
| --- | --- | --- | --- |
| `rateBucket` | `RATE_WINDOW_MS = 1_000` | `maxBatchesPerSec` | `maxBatchesPerSec / 1_000` per ms |
| `bytesBucket` | `BYTES_WINDOW_MS = 60_000` | `maxBytesPerMinute` | `maxBytesPerMinute / 60_000` per ms |

`acquire(payloadBytes)` flow:

1. Apply pending 429 (`pendingNotify429`) → `backoffSteps = min(steps + 1, 16)`. Else reset to 0.
2. Apply pending 5xx (`pendingServiceUnavailable`) → `serviceUnavailableSteps = min(steps + 1, 16)`; capture `pendingServiceUnavailableFloorMs`.
3. If `retryAfterUntil > now`, sleep `until - now`. (Wall-clock floor from `Retry-After`.)
4. If `backoffSteps > 0`: `sleep(min(MAX_BACKOFF_MS = 30_000, slotMs * (backoffMultiplier ^ steps - 1)))` where `slotMs = RATE_WINDOW_MS / capacity`.
5. If `serviceUnavailableSteps > 0`: `sleep(max(min(MAX_DELAY = 300_000, INITIAL = 30_000 * 2^(steps-1)), floorMs))`.
6. Token-bucket loop: `wait = max(timeUntil(rate, 1, t), timeUntil(bytes, min(payloadBytes, capacity), t))`. If `wait > 0`, sleep `wait` and retry. Else debit both buckets.

The three backoff signals are **independent** — `Retry-After` does not reset the 429/5xx exponential counters. They stack additively in acquisition order.

## Fallback (when there is no pacer)

Tests sometimes pass `ctx.pacer = undefined`. In that case `drainBuffer` skips all `pacer?.…` calls — no throttling, just raw cursor-walk + upload. Don't use this in production.

## Observability (uploader-emitted events)

| event | level | when |
| --- | --- | --- |
| `upload.start` | DEBUG | per attempt, before HTTP call |
| `upload.accepted` | INFO | on `accepted` outcome |
| `upload.watermark_recovered` | INFO | on `recovered` outcome |
| `upload.rate_limited` | ERROR | on `RateLimitError` |
| `upload.retriable` | ERROR | on `RetriableError` / `NetworkError` |
| `upload.fatal` | ERROR | on `ValidationError` / generic `GatewayError` / unknown |
| `upload.auth_unconfirmed` | ERROR | `verifyKey` threw non-auth |
| `upload.auth_transient` | ERROR | `verifyKey` returned success but upload 401'd |
| `auth.invalid` | FATAL | on `finalizeAuthFailure` (sentinel written) |
| `auth.sentinel_write_failed` | ERROR | sentinel write threw |
| `upload.unknown_error` | ERROR | unknown exception fell through |

All events include `capture_id` via `logger.child({ capture_id, source_app })`. HTTP-context fields are spread by `httpFields(err)` for any `GatewayError` carrying an `HttpRequestContext`.

[source: src/services/uploader/drain-buffer.ts:14-91; src/services/uploader/upload-batch.ts:24-248; src/services/uploader/build-dto.ts:4-40; src/services/uploader/pacer.ts:58-173; src/services/uploader/uploader.constants.ts:1-2; src/services/uploader/uploader.types.ts:17-69]
