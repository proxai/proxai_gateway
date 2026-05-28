import { createActor, type Actor } from 'xstate';
import { nowIsoUtc } from 'core/utils';
import {
  AuthError,
  GatewayError,
  NetworkError,
  OversizedDecompressedSliceError,
  RateLimitError,
  RetriableError,
  ValidationError,
  WatermarkRegressionError,
} from 'core/utils';
import {
  deleteBatch,
  markBatchDelivered,
  markBatchFailed,
  recordResyncEvent,
  recordRetriableFailure,
  setCursorFromRegression,
} from 'services/buffer';
import type { StoredBatch } from 'services/buffer';
import type { RawRecordDTO } from 'services/contract';
import { writeAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';
import {
  batchLifecycleMachine,
  type BatchIdentity,
  type BatchLifecycleMachine,
} from 'services/state-machines/batch-lifecycle';
import { buildRawRecordDTO } from 'services/uploader/build-dto.ts';
import type { UploadOutcome, UploaderContext } from 'services/uploader/uploader.types.ts';

function batchIdentity(batch: StoredBatch): BatchIdentity {
  return {
    captureId: batch.captureId,
    sourceApp: batch.sourceApp,
    sourcePathHash: batch.sourcePathHash,
    watermarkStart: batch.watermarkStart,
    watermarkEnd: batch.watermarkEnd,
    compressedBytes: batch.body.byteLength,
  };
}

export async function uploadBatch(
  ctx: UploaderContext,
  batch: StoredBatch,
): Promise<UploadOutcome> {
  const log = ctx.logger?.child({
    capture_id: batch.captureId,
    source_app: batch.sourceApp,
  });

  const dto: RawRecordDTO = buildRawRecordDTO(batch, ctx.hostId);
  const lifecycle = createActor(batchLifecycleMachine, { input: { batch: batchIdentity(batch) } });
  lifecycle.start();
  lifecycle.send({ type: 'DRAIN_PICKS_UP' });

  log?.debug({ event: 'upload.start', attempts: batch.attempts }, 'upload started');
  try {
    const result = await ctx.http.uploadRawRecord(dto);
    markBatchDelivered(ctx.db, batch, { idempotentOnServer: result.idempotent });
    lifecycle.send({
      type: 'ACCEPTED',
      idempotent: result.idempotent,
      deliveredAtUtc: nowIsoUtc(),
    });
    lifecycle.stop();
    log?.info({ event: 'upload.accepted', idempotent: result.idempotent }, 'upload accepted');
    return {
      kind: 'accepted',
      captureId: batch.captureId,
      idempotent: result.idempotent,
    };
  } catch (err) {
    const outcome = await classifyAndPersist(ctx, batch, err, lifecycle);
    lifecycle.stop();
    return outcome;
  }
}

async function classifyAndPersist(
  ctx: UploaderContext,
  batch: StoredBatch,
  err: unknown,
  lifecycle: Actor<BatchLifecycleMachine>,
): Promise<UploadOutcome> {
  const captureId = batch.captureId;
  const log = ctx.logger?.child({ capture_id: captureId });
  if (err instanceof WatermarkRegressionError) {
    setCursorFromRegression(ctx.db, batch, err.currentServerWatermarkEnd);
    recordResyncEvent(ctx.db, {
      sourceApp: batch.sourceApp,
      sourcePathHash: batch.sourcePathHash,
      watermarkKind: batch.watermarkKind,
      serverWatermarkEnd: err.currentServerWatermarkEnd,
      skippedUnits: err.currentServerWatermarkEnd - batch.watermarkEnd,
      recoveredAt: nowIsoUtc(),
    });
    deleteBatch(ctx.db, captureId);
    lifecycle.send({
      type: 'WATERMARK_REGRESSED',
      serverWatermarkEnd: err.currentServerWatermarkEnd,
    });
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
    lifecycle.send({
      type: 'RATE_LIMITED',
      error: err.message,
      retryAfterMs: err.retryAfterMs,
    });
    log?.error(
      {
        event: 'upload.rate_limited',
        retry_after_ms: err.retryAfterMs,
        error: err.message,
        ...httpFields(err),
      },
      'upload rate-limited',
    );
    return {
      kind: 'retriable',
      captureId,
      error: err.message,
      retryAfterMs: err.retryAfterMs,
      reason: 'rate_limit',
    };
  }
  if (err instanceof AuthError) {
    lifecycle.send({ type: 'AUTH_ERROR', error: err.message });
    return handleAuthError(ctx, batch, err, lifecycle);
  }
  if (err instanceof RetriableError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    lifecycle.send({
      type: 'SERVICE_UNAVAILABLE',
      error: err.message,
      retryAfterMs: err.retryAfterMs,
    });
    log?.error(
      {
        event: 'upload.retriable',
        kind: err.constructor.name,
        retry_after_ms: err.retryAfterMs,
        error: err.message,
        ...httpFields(err),
      },
      'upload failed (retriable)',
    );
    return {
      kind: 'retriable',
      captureId,
      error: err.message,
      retryAfterMs: err.retryAfterMs,
      reason: 'service_unavailable',
    };
  }
  if (err instanceof NetworkError) {
    recordRetriableFailure(ctx.db, captureId, err.message);
    lifecycle.send({ type: 'NETWORK_ERROR', error: err.message });
    log?.error(
      {
        event: 'upload.retriable',
        kind: err.constructor.name,
        error: err.message,
        ...httpFields(err),
      },
      'upload failed (retriable)',
    );
    return {
      kind: 'retriable',
      captureId,
      error: err.message,
      retryAfterMs: null,
      reason: 'network',
    };
  }
  if (err instanceof ValidationError || err instanceof GatewayError) {
    markBatchFailed(ctx.db, captureId, err.message);
    const failedAtUtc = nowIsoUtc();
    if (err instanceof OversizedDecompressedSliceError) {
      lifecycle.send({ type: 'OVERSIZED', error: err.message, failedAtUtc });
    } else {
      lifecycle.send({ type: 'VALIDATION_FAILED', error: err.message, failedAtUtc });
    }
    const baseFields: Record<string, unknown> = {
      event: 'upload.fatal',
      kind: err.constructor.name,
      error: err.message,
      source_path_hash: batch.sourcePathHash,
      compressed_bytes: batch.body.byteLength,
      watermark_start: batch.watermarkStart,
      watermark_end: batch.watermarkEnd,
      ...httpFields(err),
    };
    if (err instanceof OversizedDecompressedSliceError) {
      baseFields['raw_bytes'] = err.rawBytes;
      baseFields['cap'] = err.cap;
      baseFields['slice_index'] = err.sliceIndex;
    }
    log?.error(baseFields, 'upload failed (fatal)');
    return { kind: 'fatal', captureId, error: err.message };
  }
  const message = `unknown error: ${(err as Error).message ?? String(err)}`;
  markBatchFailed(ctx.db, captureId, message);
  lifecycle.send({ type: 'UNKNOWN_ERROR', error: message, failedAtUtc: nowIsoUtc() });
  log?.error({ event: 'upload.unknown_error', error: message }, 'upload failed (unknown)');
  return { kind: 'fatal', captureId, error: message };
}

async function handleAuthError(
  ctx: UploaderContext,
  batch: StoredBatch,
  authErr: AuthError,
  lifecycle: Actor<BatchLifecycleMachine>,
): Promise<UploadOutcome> {
  const captureId = batch.captureId;
  const log = ctx.logger?.child({ capture_id: captureId });

  let verification;
  try {
    verification = await ctx.http.verifyKey();
  } catch (verifyErr) {
    if (verifyErr instanceof AuthError) {
      lifecycle.send({
        type: 'VERIFY_THREW_AUTH',
        error: verifyErr.message,
        failedAtUtc: nowIsoUtc(),
      });
      return finalizeAuthFailure(ctx, batch, 'verify-key threw AuthError');
    }

    recordRetriableFailure(ctx.db, captureId, authErr.message);
    lifecycle.send({
      type: 'VERIFY_THREW_OTHER',
      error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
    });
    log?.error(
      {
        event: 'upload.auth_unconfirmed',
        kind: verifyErr instanceof Error ? verifyErr.constructor.name : typeof verifyErr,
        error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        ...(verifyErr instanceof GatewayError ? httpFields(verifyErr) : {}),
        ...httpFields(authErr),
      },
      'upload auth error; verify-key inconclusive, treating as retriable',
    );
    return {
      kind: 'retriable',
      captureId,
      error: authErr.message,
      retryAfterMs: null,
      reason: 'auth_unconfirmed',
    };
  }

  if (!verification.success) {
    const reason = verification.message.length > 0 ? verification.message : 'key not accepted';
    lifecycle.send({
      type: 'VERIFY_SUCCESS_FALSE',
      error: reason,
      failedAtUtc: nowIsoUtc(),
    });
    return finalizeAuthFailure(ctx, batch, reason);
  }

  recordRetriableFailure(ctx.db, captureId, authErr.message);
  lifecycle.send({ type: 'VERIFY_SUCCESS_TRUE', error: authErr.message });
  log?.error(
    { event: 'upload.auth_transient', error: authErr.message, ...httpFields(authErr) },
    'upload auth error; verify-key still success, treating as retriable',
  );
  return {
    kind: 'retriable',
    captureId,
    error: authErr.message,
    retryAfterMs: null,
    reason: 'auth_unconfirmed',
  };
}

function httpFields(err: GatewayError): Record<string, unknown> {
  const ctx = err.httpContext;
  if (ctx === undefined) return {};
  const out: Record<string, unknown> = { http_url: ctx.url, http_method: ctx.method };
  if (ctx.status !== null) out['http_status'] = ctx.status;
  if (ctx.bodyExcerpt !== null && ctx.bodyExcerpt.length > 0) {
    out['http_body'] = ctx.bodyExcerpt;
  }
  return out;
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
