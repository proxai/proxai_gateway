# Backend Protocol Rules

Applies to `src/services/http/**/*.ts`, `src/services/uploader/**/*.ts`, and `src/services/contract/**/*.ts`.

- The DTO shape for `POST /v1/raw_records` is `RawRecordDTO` in `contract.types.ts`. Run `validateRawRecordDTO` before every send. A DTO that fails validation is fatal — never retry it.
- `body` on the wire is always `base64(zstdCompressSync(redacted_text))`. `body_compression` is always the literal `'zstd'`. Never add a branch for a different compression or encoding.
- `capture_id` is a UUIDv7 (time-sortable) generated at insert time. It is the idempotency key server-side. Never re-use or regenerate `capture_id` for a batch already in `upload_batches`.
- The four `UploadOutcome.kind` values (`accepted`, `fatal`, `recovered`, `retriable`) are exhaustive. A `recovered` outcome (watermark regression 400) resets the cursor to the server's watermark and deletes the batch — never marks it failed.
- Upload timeout is `UPLOAD_TIMEOUT_MS = 60_000` (60 s); all other requests use `DEFAULT_TIMEOUT_MS = 30_000`. Do not use the same timeout constant for uploads and setup/verify-key calls.
- Status code mapping lives in `dispatchSuccessOrThrow` in `http/error-mapping.ts`. Do not add ad-hoc HTTP error handling outside this chokepoint.
- `AuthError` from an upload triggers `verifyKey()` to disambiguate. If `verifyKey` throws a non-auth error, the outcome is `retriable`, not fatal. Only a definitive `{ success: false }` from `verifyKey` writes `AUTH_FAILED`.
- The pacer has three independent backoff signals: `Retry-After` header, 429 exponential (capped 30 s), 5xx exponential (capped 5 min). They stack in acquisition order. Both 429 and 5xx counter step caps are 16.
