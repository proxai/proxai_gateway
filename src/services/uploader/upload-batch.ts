import {
  AuthError,
  GatewayError,
  NetworkError,
  RateLimitError,
  RetriableError,
  ValidationError,
  WatermarkRegressionError,
} from 'core/utils';
import {
  deleteBatch,
  markBatchDelivered,
  markBatchFailed,
  recordRetriableFailure,
  setCursorFromRegression,
} from 'services/buffer';
import type { StoredBatch } from 'services/buffer';
import type { RawRecordDTO } from 'services/contract';
import { writeAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';
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

  const dto: RawRecordDTO = buildRawRecordDTO(batch, ctx.hostId);

  log?.debug({ event: 'upload.start', attempts: batch.attempts }, 'upload started');
  try {
    const result = await ctx.http.uploadRawRecord(dto);
    markBatchDelivered(ctx.db, batch, { idempotentOnServer: result.idempotent });
    log?.info({ event: 'upload.accepted', idempotent: result.idempotent }, 'upload accepted');
    return {
      kind: 'accepted',
      captureId: batch.captureId,
      idempotent: result.idempotent,
    };
  } catch (err) {
    return classifyAndPersist(ctx, batch, err);
  }
}

async function classifyAndPersist(
  ctx: UploaderContext,
  batch: StoredBatch,
  err: unknown,
): Promise<UploadOutcome> {
  const captureId = batch.captureId;
  const log = ctx.logger?.child({ capture_id: captureId });
  if (err instanceof WatermarkRegressionError) {
    // Server already has data up to err.currentServerWatermarkEnd for this
    // source_path_hash. Update our local cursor to match, drop the failed
    // batch (it duplicates server state), and let the next cycle resume from
    // the new cursor position forward.
    setCursorFromRegression(ctx.db, batch, err.currentServerWatermarkEnd);
    deleteBatch(ctx.db, captureId);
    log?.info(
      {
        event: 'upload.watermark_recovered',
        new_watermark_end: err.currentServerWatermarkEnd,
        source_path_hash: err.sourcePathHash,
      },
      'watermark regression recovered from server state',
    );
    return { kind: 'recovered', captureId };
  }
  if (err instanceof RateLimitError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    log?.warn(
      { event: 'upload.rate_limited', retry_after_ms: err.retryAfterMs, error: err.message },
      'upload rate-limited',
    );
    return { kind: 'retriable', captureId, error: err.message, retryAfterMs: err.retryAfterMs };
  }
  if (err instanceof AuthError) {
    return handleAuthError(ctx, batch, err);
  }
  if (err instanceof RetriableError || err instanceof NetworkError) {
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

async function handleAuthError(
  ctx: UploaderContext,
  batch: StoredBatch,
  authErr: AuthError,
): Promise<UploadOutcome> {
  const captureId = batch.captureId;
  const log = ctx.logger?.child({ capture_id: captureId });

  // Reactive verify-key disambiguates "transient 401/403" from "key actually
  // revoked". One extra request per failed upload — never recurses on the
  // verify-key call itself.
  let verification;
  try {
    verification = await ctx.http.verifyKey();
  } catch (verifyErr) {
    if (verifyErr instanceof AuthError) {
      return finalizeAuthFailure(ctx, batch, 'verify-key threw AuthError');
    }
    // 5xx, network failure, etc. — cannot confirm the key is bad, so retry.
    recordRetriableFailure(ctx.db, captureId, authErr.message);
    log?.warn(
      {
        event: 'upload.auth_unconfirmed',
        kind: verifyErr instanceof Error ? verifyErr.constructor.name : typeof verifyErr,
        error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
      },
      'upload auth error; verify-key inconclusive, treating as retriable',
    );
    return { kind: 'retriable', captureId, error: authErr.message, retryAfterMs: null };
  }

  if (!verification.success) {
    const reason = verification.message.length > 0 ? verification.message : 'key not accepted';
    return finalizeAuthFailure(ctx, batch, reason);
  }

  // verify-key reports success — the upload's 401/403 was transient.
  recordRetriableFailure(ctx.db, captureId, authErr.message);
  log?.warn(
    { event: 'upload.auth_transient', error: authErr.message },
    'upload auth error; verify-key still success, treating as retriable',
  );
  return { kind: 'retriable', captureId, error: authErr.message, retryAfterMs: null };
}

async function finalizeAuthFailure(
  ctx: UploaderContext,
  batch: StoredBatch,
  reason: string,
): Promise<UploadOutcome> {
  const captureId = batch.captureId;
  const log = ctx.logger?.child({ capture_id: captureId });
  const message = 'ingestion key invalid';
  markBatchFailed(ctx.db, captureId, message);
  if (ctx.authFailedSentinelPath !== undefined) {
    try {
      await writeAuthFailedSentinel(ctx.authFailedSentinelPath, reason);
    } catch (writeErr) {
      log?.error(
        {
          event: 'auth.sentinel_write_failed',
          error: writeErr instanceof Error ? writeErr.message : String(writeErr),
        },
        'failed to write AUTH_FAILED sentinel',
      );
    }
  }
  log?.fatal({ event: 'auth.invalid', reason, capture_id: captureId }, 'ingestion key invalid');
  return { kind: 'fatal', captureId, error: message };
}
