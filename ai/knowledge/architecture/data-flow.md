# Data Flow

- End-to-end pipeline: discover → filter+trim → redact (`applyRedaction`) → encode → `zstdCompressSync(level=3)` → `insertBatch` → `nextPendingBatch` → `pacer.acquire` → `uploadRawRecord` → `markBatchDelivered`.
- Redaction runs before compression; the size budget (`BODY_MAX_COMPRESSED_BYTES = 2 MiB`, `BODY_MAX_DECOMPRESSED_BYTES = 10 MiB`) is measured against the post-redaction body. Source: `contract.constants.ts`.
- Splitting is done by `splitJsonlAtBoundary` (binary-search over newline indices, `core/utils/jsonl-split.ts`) and `splitRowsByCompressedSize` (binary-search over row arrays, `core/utils/rowid-split.ts`). Both share a "find largest prefix fitting both budgets" pattern.
- Workers use in-memory `:memory:` DBs during capture; the main thread commits all results in a single ACID transaction. Prevents concurrent DB lock conflicts.
- On the wire, the body is `base64(zstd(redacted_utf8))` — ~33% overhead vs binary. This is intentional (simpler error handling); `body_compression = 'zstd'` always.
- Idempotency key is `capture_id` (UUIDv7), which is also the primary key on `upload_batches`. Server dedupes on it.
- Watermarks ride with every batch: `watermark_kind`, `watermark_start`, `watermark_end`, `watermark_table`. The server can return these via `GET /v1/watermarks` to seed a fresh `buffer.db`.
- `source_path` (absolute host path) is transmitted unredacted. The on-device redaction pipeline does not touch paths.
