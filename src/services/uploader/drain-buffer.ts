import { nextPendingBatch, nextPendingBatchAfter } from 'services/buffer';
import type { StoredBatch } from 'services/buffer';
import {
  DEFAULT_MAX_BATCHES_PER_DRAIN,
  DRAIN_MAX_CONSECUTIVE_RETRIABLE,
} from 'services/uploader/uploader.constants.ts';
import type {
  DrainOptions,
  DrainResult,
  UploaderContext,
} from 'services/uploader/uploader.types.ts';
import { uploadBatch } from 'services/uploader/upload-batch.ts';

export async function drainBuffer(
  ctx: UploaderContext,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const cap = options.maxBatches ?? DEFAULT_MAX_BATCHES_PER_DRAIN;
  const maxConsecutiveRetriable =
    options.maxConsecutiveRetriable ?? DRAIN_MAX_CONSECUTIVE_RETRIABLE;
  const result: DrainResult = {
    attempted: 0,
    accepted: 0,
    retriable: 0,
    fatal: 0,
    recovered: 0,
    rateLimitedRetryAfterMs: null,
    consecutiveRetriableBreak: false,
    lastUploadError: null,
  };

  let consecutiveRetriable = 0;
  let cursor: { createdAt: string; captureId: string } | null = null;

  while (result.attempted < cap) {
    const batch: StoredBatch | null =
      cursor === null ? nextPendingBatch(ctx.db) : nextPendingBatchAfter(ctx.db, cursor);
    if (batch === null) break;

    if (ctx.pacer !== undefined) {
      await ctx.pacer.acquire(batch.body.byteLength);
    }
    const outcome = await uploadBatch(ctx, batch);
    result.attempted++;
    cursor = { createdAt: batch.createdAt, captureId: batch.captureId };

    if (outcome.kind === 'accepted') {
      result.accepted++;
      consecutiveRetriable = 0;
      continue;
    }
    if (outcome.kind === 'fatal') {
      result.fatal++;
      result.lastUploadError = outcome.error;
      consecutiveRetriable = 0;
      continue;
    }
    if (outcome.kind === 'recovered') {
      result.recovered++;
      consecutiveRetriable = 0;
      continue;
    }
    if (ctx.pacer !== undefined) {
      if (outcome.retryAfterMs !== null && outcome.retryAfterMs > 0) {
        ctx.pacer.notifyRetryAfter(outcome.retryAfterMs);
      }
      if (outcome.reason === 'rate_limit') {
        ctx.pacer.notify429();
      } else if (outcome.reason === 'service_unavailable') {
        ctx.pacer.notifyServiceUnavailable(outcome.retryAfterMs ?? undefined);
      }
    }
    result.retriable++;
    result.rateLimitedRetryAfterMs = outcome.retryAfterMs;
    result.lastUploadError = outcome.error;
    consecutiveRetriable++;
    if (consecutiveRetriable >= maxConsecutiveRetriable) {
      result.consecutiveRetriableBreak = true;
      break;
    }
  }

  return result;
}
