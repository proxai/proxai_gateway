# http

`src/services/http/` is the outbound client to proxai_nest. One class (`HttpClient`), four methods, one centralised error-mapping chokepoint (`dispatchSuccessOrThrow`).

## Endpoints

| Method | URL helper / endpoint path | Purpose | Timeout |
| --- | --- | --- | --- |
| `GET` | `nestVerifyKeyUrl` / `/ingestion/verify-key` | Validate the `X-API-Key` header. Used by setup, status, and the uploader's `handleAuthError` disambiguation. | `DEFAULT_TIMEOUT_MS = 30_000` |
| `POST` | `nestRegisterHostIdUrl` / `/v1/host-ids/register` | Idempotent host-id registration during setup. | 30 s |
| `GET` | `nestWatermarksUrl` / `/v1/watermarks?host_id=…` | Pull all server-known cursors. Used to seed a fresh `buffer.db` (see `watermark-sync.ts`). | 30 s |
| `POST` | `nestIngestUrl` / `/v1/raw_records` | Single-record upload. Body is a full `RawRecordDTO`. | `UPLOAD_TIMEOUT_MS = 60_000` |

Upload uses 60 s; everything else uses 30 s. Do not collapse them — uploads must tolerate a slower path because the body can be up to 2 MiB compressed.

## Constructor

```ts
new HttpClient({
  apiKey: string,
  hostId: string,
  endpoints: { ingest, verifyKey, watermarks, registerHostId },
  gatewayVersion?: string,  // sets User-Agent; defaults to '@proxai/gateway'
  timeoutMs?: number,       // default 30_000
  fetch?: typeof globalThis.fetch,  // for tests
});
```

One instance per daemon — constructed at bootstrap with config + resolved endpoints, then threaded into `DrainCycleContext`. Never re-instantiated mid-run.

## Headers

| Header | Value | Set when |
| --- | --- | --- |
| `User-Agent` | `gatewayVersion ?? '@proxai/gateway'` | every request |
| `X-API-Key` | `apiKey` | `withApiKey: true` requests (all four methods) |
| `Content-Type` | `application/json` | requests with a body (uploads, host-id register) |
| `X-Client-Timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | raw record upload (`withClientTimezone: true` requests) |

No `Authorization: Bearer` — auth is the custom `X-API-Key` header.

## Status → typed-error mapping

All non-2xx responses route through `dispatchSuccessOrThrow` (the only HTTP error chokepoint). Mapping table:

| Status | Typed error | Classification in uploader |
| --- | --- | --- |
| 200 / 201 | (success: `JSON.parse(body)`; empty body → `FatalError`) | accepted |
| 400 with `error: 'watermark_regression'` body | `WatermarkRegressionError(currentEnd, sourcePathHash)` | **recovered** (cursor reset + batch deleted) |
| 400 (other) | `ValidationError(`server returned 400 …`)` | fatal |
| 401 | `AuthError('…401: gateway key missing or invalid')` | triggers `verifyKey()` disambiguation |
| 403 | `AuthError('…403: host not authorized for this gateway key')` | same `verifyKey()` disambiguation — a 403 is the transient "valid key, host binding not ready yet" condition and self-heals as retriable; only a definitive verify-key `{ success: false }` (or verify-key `AuthError`) makes it fatal |
| 408 | `ValidationError('server returned 408 (decompress timeout — gateway bug)')` | fatal |
| 413 | `ValidationError('server returned 413 (payload too large)')` | fatal |
| 429 | `RateLimitError(message, retryAfterMs)` | retriable, `pacer.notify429()` |
| 5xx | `RetriableError(message, retryAfterMs)` | retriable, `pacer.notifyServiceUnavailable(retryAfterMs?)` |
| other | `FatalError(`unexpected status: …`)` | fatal |

Every error wraps in `withCtx(err, makeHttpContext(url, method, status, body))` — the context attaches `{ url, method, status, bodyExcerpt }` (body truncated at `RESPONSE_BODY_EXCERPT_LIMIT = 512`). The uploader spreads `httpFields(err)` into log events.

## Network/timeout handling

In `client.request`:
- `signal: AbortSignal.timeout(timeoutMs)` — uses the new TC39 `AbortSignal.timeout` for built-in deadline.
- On the catch path, `err.name === 'TimeoutError' || 'AbortError'` → `RetriableError(`request timed out after Nms`, null, err)` (retriable, no `Retry-After`).
- Any other thrown error → `NetworkError('network failure: …', err)` (retriable, reason `'network'`).

## Retries, backoff

`HttpClient` does **not** retry. The client is single-shot per call. All retry logic lives in `services/uploader/pacer.ts` and is driven by the drain loop. The pacer has three independent backoff signals stacked in `acquire`:

| Signal | Trigger | Behavior |
| --- | --- | --- |
| `Retry-After` header (parsed via `parseRetryAfter` in `core/utils`) | any 429 or 5xx that carries it | `notifyRetryAfter(ms)` sets a one-shot wall-clock floor for the next `acquire`. |
| 429 exponential | `notify429()` from drain | `backoffSteps++`, capped at 16; computed as `slotMs * (backoffMultiplier ^ steps − 1)`, then `Math.min(MAX_BACKOFF_MS = 30_000, …)`. Resets to 0 on the next non-429 acquire. |
| 5xx exponential | `notifyServiceUnavailable(retryAfterMs?)` | `serviceUnavailableSteps++`, capped at 16; computed as `min(MAX_DELAY = 300_000, INITIAL = 30_000 * 2^(steps−1))`; combined with `pendingServiceUnavailableFloorMs` via `Math.max`. |

Token-bucket pacing runs **after** backoff — two buckets, `rateBucket` (max batches/sec) and `bytesBucket` (max bytes/min). Both must have enough tokens or `acquire` sleeps for `max(timeUntil(rate), timeUntil(bytes))`.

## What `HttpClient` exposes

- `hostIdentifier: string` (read-only accessor for `this.hostId`).
- `verifyKey()` → `{ success, message, userId, keyName }`.
- `registerHostId()` → `{ hostId, userId, registered }`.
- `fetchWatermarks()` → `{ hostId, userId, watermarks: ServerWatermark[] }` (parses each via `parseServerWatermark`, drops malformed entries silently).
- `uploadRawRecord(dto)` → `{ captureId, accepted, idempotent }`. Calls `validateRawRecordDTO(dto)` first — local validation failure throws before any network round-trip.

[source: src/services/http/client.ts:30-176; src/services/http/error-mapping.ts:15-81; src/services/http/http.constants.ts:1-24; src/services/http/parse-helpers.ts:3-56; src/services/http/http-context.ts:5-24; src/services/uploader/pacer.ts:58-173]
