import { nextPendingBatch } from 'services/buffer';
import { DEFAULT_MAX_BATCHES_PER_DRAIN } from 'services/uploader/uploader.constants.ts';
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
  const result: DrainResult = {
    attempted: 0,
    accepted: 0,
    retriable: 0,
    fatal: 0,
    recovered: 0,
    rateLimitedRetryAfterMs: null,
  };

  while (result.attempted < cap) {
    const batch = nextPendingBatch(ctx.db);
    if (batch === null) break;

    if (ctx.pacer !== undefined) {
      await ctx.pacer.acquire(batch.body.byteLength);
    }
    const outcome = await uploadBatch(ctx, batch);
    result.attempted++;

    if (outcome.kind === 'accepted') {
      result.accepted++;
      continue;
    }
    if (outcome.kind === 'fatal') {
      result.fatal++;
      continue;
    }
    if (outcome.kind === 'recovered') {
      result.recovered++;
      continue;
    }
    if (ctx.pacer !== undefined) {
      if (outcome.retryAfterMs !== null && outcome.retryAfterMs > 0) {
        ctx.pacer.notifyRetryAfter(outcome.retryAfterMs);
      }
      // Route distress signals by reason. auth_unconfirmed and network are
      // not server-distress signals — they're transport/identity faults that
      // shouldn't make us slow down ordinary traffic.
      if (outcome.reason === 'rate_limit') {
        ctx.pacer.notify429();
      } else if (outcome.reason === 'service_unavailable') {
        ctx.pacer.notifyServiceUnavailable(outcome.retryAfterMs ?? undefined);
      }
    }
    result.retriable++;
    result.rateLimitedRetryAfterMs = outcome.retryAfterMs;
    break;
  }

  return result;
}
