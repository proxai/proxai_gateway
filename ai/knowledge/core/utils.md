# Core Utils

`src/core/utils/` is the cross-cutting helper bag. Each file owns one concern and is independently importable from `core/utils` (the barrel `index.ts` re-exports everything). When you need a utility, check here first — if it exists, use it; if it doesn't, add it here rather than copy-pasting into a service.

## What's where

| File | Exports | Reach for when... |
| --- | --- | --- |
| `backoff.ts` | `exponentialBackoff(opts?)`, `parseRetryAfter(header, now?)` | retry loops, Retry-After header parsing |
| `compress.ts` | `zstdCompressSync(data, level=3)`, `zstdDecompressSync(data)` | wire-format encoding (we always use zstd) |
| `errors.ts` | `GatewayError`, `ValidationError`, `AuthError`, `RateLimitError`, `RetriableError`, `NetworkError`, `FatalError`, `UserAbortedError`, `WatermarkRegressionError`, `OversizedDecompressedSliceError`, `HttpRequestContext` | throwing structured errors anywhere |
| `format.ts` | `formatLocalTimestamp`, `formatRelative`, `formatTimeWithRelative`, `formatBytes`, `formatDuration`, `formatPercent` | human-readable output (status, tail, inspect) |
| `hash.ts` | `sha256Hex(input)` | hashing source paths, deriving host-id |
| `jsonl-split.ts` | `splitJsonlAtBoundary(bytes, options)` | splitting a JSONL byte slice into compressed-size-bounded batches |
| `package-info.ts` | `PACKAGE_NAME`, `PACKAGE_VERSION`, `PACKAGE_DESCRIPTION`, `GATEWAY_USER_AGENT` | identifying the gateway in HTTP requests, version output, logs |
| `rowid-split.ts` | `splitRowsByCompressedSize(rows, options)` | splitting sqlite row arrays into compressed-size-bounded batches |
| `source-path.ts` | `currentGenerationNumber`, `stripGenerationSuffix`, `nextGenerationSuffix` | bumping `#gen=N` suffix when VACUUM is detected |
| `strip-marker-block.ts` | `stripMarkerBlock(content, options)` | removing a marker+next-line pair from a file (used by `uninstall` PATH cleanup) |
| `time.ts` | `nowIsoUtc()`, `daysSince(iso, now)`, `monotonicMs()`, `abortableSleep(ms, signal?)` | timestamps, age math, signal-aware sleeps |
| `utils.constants.ts` | `DEFAULT_BACKOFF` | backoff defaults: 30 s initial, 1 h max, multiplier 2, jitter 0.2 |
| `utils.types.ts` | `BackoffOptions`, `ErrorCategory` | typing the above |
| `uuid.ts` | `generateUuidV7()`, `isUuidV7(value)` | `capture_id` generation (time-sortable) |

## Error hierarchy

`GatewayError extends Error` is the root. It carries `category: ErrorCategory` (one of `'validation' | 'auth' | 'rate-limit' | 'retriable' | 'network' | 'fatal'`) and an optional `cause` plus an attachable `httpContext` (URL/method/status/body excerpt). Subclasses pre-set the category:

| Class | Category | Extra fields |
| --- | --- | --- |
| `ValidationError` | `validation` | — |
| `AuthError` | `auth` | — |
| `RateLimitError` | `rate-limit` | `retryAfterMs: number \| null` |
| `RetriableError` | `retriable` | `retryAfterMs: number \| null` |
| `NetworkError` | `network` | — |
| `FatalError` | `fatal` | — |
| `WatermarkRegressionError extends ValidationError` | `validation` | `currentServerWatermarkEnd`, `sourcePathHash` |
| `OversizedDecompressedSliceError extends ValidationError` | `validation` | `sourcePath`, `sourcePathHash`, `rawBytes`, `compressedBytes`, `sliceIndex`, `cap` |
| `UserAbortedError extends Error` | — (not Gateway) | — (top-level catches → exit 130) |

The top-level `program.parseAsync().catch(...)` in `main.ts` matches on `UserAbortedError` then `GatewayError` then generic `Error`. Throwing a `GatewayError` from anywhere in the stack always produces a clean "✗ <message>" line; throwing a plain `Error` includes the stack.

## Split helpers — the shared pattern

Both `splitJsonlAtBoundary` (line-bounded) and `splitRowsByCompressedSize` (row-bounded) implement the same "find largest prefix that fits both budgets" pattern via binary search.

| Option | Type | Meaning |
| --- | --- | --- |
| `measureCompressed(slice)` | `(Uint8Array \| readonly T[]) → number` | typically `zstdCompressSync(slice).byteLength` |
| `targetCompressedBytes` | `number` | hard ceiling for the compressed slice |
| `maxDecompressedBytes` | `number` | hard ceiling for the raw slice |
| `measureUncompressed(rows)` (rowid only) | `(readonly T[]) → number` | sum of raw row sizes |

Output: an array of slices (jsonl) or readonly row arrays (rowid), each meeting both budgets. The implementations are recursive in feel but iterative in code; each chunk gets the largest prefix that fits, then the cursor advances.

## `abortableSleep(ms, signal?)`

Used by daemon loops and by `tail --follow`. Resolves either when `ms` elapse or when `signal` fires. Crucially: if the signal is already aborted at call time, returns immediately with no `setTimeout`. The cleanup path cancels both the timer and the abort listener — no leaks under repeated calls.

## `parseRetryAfter(header, now?)`

Accepts both forms of the HTTP `Retry-After` header:

- Delta-seconds (`"30"`, `"30.5"`) → returns the value in ms.
- HTTP-date (`"Wed, 21 Oct 2025 07:28:00 GMT"`) → returns `epoch - now` clamped to `≥ 0`.

Returns `null` on missing/empty/unparseable. The pacer combines this signal with its own exponential backoff (see `ai/rules/services/backend-protocol.md`).

## `nextGenerationSuffix(path)`

When VACUUM regression is detected on a sqlite source, the watermark key for that source must change so the server treats it as a fresh stream. We append `#gen=N` to the source path. `currentGenerationNumber` reads it back, `stripGenerationSuffix` removes it, `nextGenerationSuffix` bumps it. The suffix is regex-anchored to `#gen=N$` so paths legitimately containing `#gen=` elsewhere (extremely unlikely) wouldn't collide.

## When to reach for which

- Need a hash of a string for routing/dedup? `sha256Hex`. Not `crypto.subtle` — slower in Bun.
- Need a UUID for a new batch? `generateUuidV7`. Not `crypto.randomUUID()` — we rely on time-sortability server-side.
- Need to compress for the wire? `zstdCompressSync(data, 3)`. The `level=3` default matches what the contract documents; don't pass another level without reading `BODY_MAX_COMPRESSED_BYTES`.
- Need to print bytes for a human? `formatBytes`. Don't roll your own.
- Need to print a duration? `formatDuration`. It picks the right unit (ms/s/min/h+m/d+h).
- Need to wait but respect abort? `abortableSleep`. Never `setTimeout` directly inside a daemon loop.
- Need a structured error? Pick the most specific subclass. `GatewayError(category, msg)` is the fallback when nothing fits.

[source: src/core/utils/index.ts:1; src/core/utils/backoff.ts:4,14; src/core/utils/compress.ts:1; src/core/utils/errors.ts:10,28,34,40,48,56,62,68,75,99; src/core/utils/format.ts:27,56,91,105,120; src/core/utils/hash.ts:1; src/core/utils/jsonl-split.ts:9,53; src/core/utils/package-info.ts:1; src/core/utils/rowid-split.ts:8,55; src/core/utils/source-path.ts:3,11,15; src/core/utils/strip-marker-block.ts:12; src/core/utils/time.ts:1,5,12,16; src/core/utils/utils.constants.ts:3; src/core/utils/utils.types.ts:1; src/core/utils/uuid.ts:3,7]
