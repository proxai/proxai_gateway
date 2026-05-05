import {
  AuthError,
  GatewayError,
  NetworkError,
  RateLimitError,
  RetriableError,
  ValidationError,
} from 'core/utils';
import { markBatchDone, markBatchFailed, recordRetriableFailure } from 'services/buffer';
import type { StoredBatch } from 'services/buffer';
import type { RawRecordDTO } from 'services/contract';
import { buildRawRecordDTO } from 'services/uploader/build-dto.ts';
import type { UploadOutcome, UploaderContext } from 'services/uploader/uploader.types.ts';

export async function uploadBatch(
  ctx: UploaderContext,
  batch: StoredBatch,
): Promise<UploadOutcome> {
  let dto: RawRecordDTO;
  try {
    dto = buildRawRecordDTO(batch, ctx.hostId);
  } catch (err) {
    const message = `dto build failed: ${(err as Error).message}`;
    markBatchFailed(ctx.db, batch.captureId, message);
    return { kind: 'fatal', captureId: batch.captureId, error: message };
  }

  try {
    const result = await ctx.http.uploadRawRecord(dto);
    markBatchDone(ctx.db, batch.captureId);
    return {
      kind: 'accepted',
      captureId: batch.captureId,
      idempotent: result.idempotent,
    };
  } catch (err) {
    return classifyAndPersist(ctx, batch.captureId, err);
  }
}

function classifyAndPersist(ctx: UploaderContext, captureId: string, err: unknown): UploadOutcome {
  if (err instanceof RateLimitError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    return { kind: 'retriable', captureId, error: err.message, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof AuthError || err instanceof RetriableError || err instanceof NetworkError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    return { kind: 'retriable', captureId, error: err.message, retryAfterMs: null };
  }
  if (err instanceof ValidationError || err instanceof GatewayError) {
    markBatchFailed(ctx.db, captureId, err.message);
    return { kind: 'fatal', captureId, error: err.message };
  }
  const message = `unknown error: ${(err as Error).message ?? String(err)}`;
  markBatchFailed(ctx.db, captureId, message);
  return { kind: 'fatal', captureId, error: message };
}
