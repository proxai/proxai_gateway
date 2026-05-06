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
  const log = ctx.logger?.child({
    capture_id: batch.captureId,
    source_app: batch.sourceApp,
  });

  let dto: RawRecordDTO;
  try {
    dto = buildRawRecordDTO(batch, ctx.hostId);
  } catch (err) {
    const message = `dto build failed: ${(err as Error).message}`;
    markBatchFailed(ctx.db, batch.captureId, message);
    log?.error({ event: 'upload.dto_build_failed', error: message }, 'dto build failed');
    return { kind: 'fatal', captureId: batch.captureId, error: message };
  }

  log?.debug({ event: 'upload.start', attempts: batch.attempts }, 'upload started');
  try {
    const result = await ctx.http.uploadRawRecord(dto);
    markBatchDone(ctx.db, batch.captureId);
    log?.info({ event: 'upload.accepted', idempotent: result.idempotent }, 'upload accepted');
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
  const log = ctx.logger?.child({ capture_id: captureId });
  if (err instanceof RateLimitError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    log?.warn(
      { event: 'upload.rate_limited', retry_after_ms: err.retryAfterMs, error: err.message },
      'upload rate-limited',
    );
    return { kind: 'retriable', captureId, error: err.message, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof AuthError || err instanceof RetriableError || err instanceof NetworkError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    log?.warn(
      { event: 'upload.retriable', kind: err.constructor.name, error: err.message },
      'upload failed (retriable)',
    );
    return { kind: 'retriable', captureId, error: err.message, retryAfterMs: null };
  }
  if (err instanceof ValidationError || err instanceof GatewayError) {
    markBatchFailed(ctx.db, captureId, err.message);
    log?.error(
      { event: 'upload.fatal', kind: err.constructor.name, error: err.message },
      'upload failed (fatal)',
    );
    return { kind: 'fatal', captureId, error: err.message };
  }
  const message = `unknown error: ${(err as Error).message ?? String(err)}`;
  markBatchFailed(ctx.db, captureId, message);
  log?.error({ event: 'upload.unknown_error', error: message }, 'upload failed (unknown)');
  return { kind: 'fatal', captureId, error: message };
}
