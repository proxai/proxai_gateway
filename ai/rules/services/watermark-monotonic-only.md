---
name: "Watermark Monotonicity Enforcement"
description: "Monotonic forward-only movement rules for watermark cursors to prevent regression errors."
activation: "contextual"
scenarios: ["Writing watermark updates to database source cursors", "Handling server-issued watermark correction handshakes", "Debugging watermark regression errors on upload cycle"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Watermark Monotonicity Rule


**`watermark_end` for a given `(source_app, source_path_hash, source_inode,
watermark_table)` key must only move forward. Any code path that writes
a smaller value than what is currently stored is a bug — unless that path
is `setCursorFromRegression` reacting to a server-issued correction.**

This rule documents the contract that the on-device collect logic, the
DTO validator, and the server's BullMQ ingest job all enforce together.
Violating it locally causes server-side rejection (HTTP 400
`watermark_regression`) and forces a recovery handshake on the next drain
cycle.

## The contract

1. **Collect on success**: write `watermarkEnd = new_end_position`
   where `new_end_position > prior.watermarkEnd`.
2. **Collect on error**: write `watermarkEnd = prior.watermarkEnd`
   (unchanged) with `consecutiveErrors: priorErrors + 1`. Never set
   `watermarkEnd` to anything less than `prior.watermarkEnd`.
3. **DTO validation** (`services/contract/validate.ts:109-111`):
   `watermark.start >= watermark.end` is a fatal `ValidationError`. The
   batch never reaches the wire.
4. **Server side** rejects `watermark_end < stored_server_end` with
   `{ error: 'watermark_regression', current_server_watermark_end,
   source_path_hash }`.

## The handshake (the one allowed regression)

When the server returns `watermark_regression`, the gateway must:

1. Parse the response via
   `parseWatermarkRegression(text)` — extract
   `currentServerWatermarkEnd` and `sourcePathHash`.
2. Throw `WatermarkRegressionError` (caught by
   `upload-batch.ts:57-69`).
3. Call `setCursorFromRegression(db, batch,
   currentServerWatermarkEnd)`. This is the **only** function permitted
   to write a smaller `watermark_end` than the prior value, and only
   because the server is the source of truth.
4. `deleteBatch(captureId)` — the local batch is redundant.
5. Return `UploadOutcome.kind = 'recovered'`. It does NOT count toward
   retriable backoff or fatal counters.

`setCursorFromRegression` preserves prior `lastSeenSizeBytes` /
`lastSeenPageCount` so VACUUM detection (`detectVacuum`) does not
false-fire on the next capture cycle.

## What this protects against

- **Buffer DB restored from a stale backup**: the local cursor is
  behind the server. First upload returns regression; cursor jumps
  forward to match server. Self-healing.
- **Daemon reinstalled with fresh `buffer.db`** (cursor = 0): first
  upload returns regression; cursor jumps to server's watermark.
  Subsequent captures resume from there.
- **Same path captured by two hosts** (rare, e.g. NFS-mounted home
  directory): both hosts maintain independent cursors; server has one
  truth. Whichever host ships first wins; the other recovers via
  regression.

## What this does not protect against

- A bug in the collect logic that silently advances `watermark_end`
  past data it failed to capture. The gateway has no `watermark_start
  > prior.watermark_end` gap detector — the server will store the new
  `watermark_end` and the skipped range is lost. **All `collect.ts`
  changes must keep `watermark_end` strictly = `last_captured_position
  + 1`** (rowid) or `= last_captured_byte_offset` (byte_range).

## Code search query

`grep -rn "setCursor\|setCursorFromRegression\|watermark_end" src/`
should show exactly:
- `setCursor` calls in `src/sources/*/collect.ts` and in the worker
  finalizer (`polling/capture-cycle.ts`).
- `setCursorFromRegression` only in `services/uploader/upload-batch.ts`.

Anything else writing `watermark_end` directly via raw SQL is a
violation of both this rule and `no-direct-sqlite-outside-buffer.md`.

[source: src/services/contract/validate.ts, src/services/buffer/cursors.ts, src/services/uploader/upload-batch.ts, src/services/http/parse-helpers.ts, src/core/utils/errors.ts]
