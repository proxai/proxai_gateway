import { nowIsoUtc } from 'core/utils';
import {
  checkPendingPressure,
  getMetadata,
  pruneBuffer,
  setDaemonState,
  setMetadata,
  uploadBatchesShippedKey,
  uploadBytesShippedKey,
} from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type { DaemonStateSnapshot, PruneResult } from 'services/buffer';
import type { PendingPressureResult } from 'services/buffer';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import { clearBufferFullSentinel, isBufferFull } from 'services/polling/buffer-full-sentinel.ts';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import type { DrainCycleContext, DrainCycleResult } from 'services/polling/polling.types.ts';
import { drainBuffer } from 'services/uploader';
import type { DrainResult } from 'services/uploader';

export async function runDrainCycle(ctx: DrainCycleContext): Promise<DrainCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  log?.info({ event: 'drain.cycle.start', started_at: startedAt }, 'drain cycle started');

  if (await isAuthFailed(ctx.authFailedSentinelPath)) {
    return finishSkip(startedAt, startMs, 'auth_failed', log, {
      authFailed: true,
      paused: false,
    });
  }
  if (await isPaused(ctx.pauseSentinelPath)) {
    return finishSkip(startedAt, startMs, 'paused', log, { authFailed: false, paused: true });
  }

  const uploaderCtx: Parameters<typeof drainBuffer>[0] = {
    db: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
  };
  if (log !== undefined) uploaderCtx.logger = log;
  if (ctx.pacer !== undefined) uploaderCtx.pacer = ctx.pacer;
  const drainResult = await drainBuffer(uploaderCtx);
  log?.info(
    {
      event: 'drain.complete',
      attempted: drainResult.attempted,
      accepted: drainResult.accepted,
      retriable: drainResult.retriable,
      fatal: drainResult.fatal,
      recovered: drainResult.recovered,
      retry_after_ms: drainResult.rateLimitedRetryAfterMs,
    },
    'buffer drain complete',
  );

  let pruneResult: PruneResult | null = null;
  try {
    const pruneInput: Parameters<typeof pruneBuffer>[0] = {
      db: ctx.buffer,
      receiptRetentionDays: ctx.bufferPolicy.receiptRetentionDays,
      failedRetentionDays: ctx.bufferPolicy.failedRetentionDays,
    };
    if (log !== undefined) pruneInput.logger = log;
    pruneResult = pruneBuffer(pruneInput);
  } catch (err) {
    log?.warn(
      { event: 'buffer.prune_failed', error: (err as Error).message ?? String(err) },
      'buffer prune failed; continuing drain',
    );
  }

  const pressureResult = await applyResumeSentinel(ctx, log);

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'drain.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'drain cycle complete',
  );

  persistDaemonState(ctx, startedAt, completedAt, durationMs, drainResult);
  persistDrainMetrics(ctx, completedAt, durationMs, drainResult);

  return {
    paused: false,
    authFailed: false,
    startedAt,
    completedAt,
    durationMs,
    drainResult,
    pruneResult,
    pressureResult,
  };
}

async function applyResumeSentinel(
  ctx: DrainCycleContext,
  log: DrainCycleContext['logger'],
): Promise<PendingPressureResult> {
  const result = checkPendingPressure({
    db: ctx.buffer,
    softPauseBytes: ctx.bufferPolicy.softPauseBytes,
    softResumeBytes: ctx.bufferPolicy.softResumeBytes,
  });
  if (result.shouldResume) {
    const wasFull = await isBufferFull(ctx.bufferFullSentinelPath);
    if (wasFull) {
      await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
      log?.info(
        {
          event: 'buffer.soft_resume',
          pending_bytes: result.pendingBytes,
          threshold: ctx.bufferPolicy.softResumeBytes,
        },
        'buffer pending pressure dropped below resume threshold; sentinel cleared after drain',
      );
    }
  }
  return result;
}

function persistDaemonState(
  ctx: DrainCycleContext,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  drainResult: DrainResult,
): void {
  try {
    const snapshot: DaemonStateSnapshot = {
      lastCycleStartedAt: startedAt,
      lastCycleCompletedAt: completedAt,
      lastCycleDurationMs: durationMs,
      lastDrainAttempted: drainResult.attempted,
      lastDrainAccepted: drainResult.accepted,
      lastDrainRetriable: drainResult.retriable,
      lastDrainFatal: drainResult.fatal,
      lastDrainRecovered: drainResult.recovered,
      lastUploadError: drainResult.lastUploadError,
      lastConsecutiveRetriableBreak: drainResult.consecutiveRetriableBreak,
      lastSourceCaptures: {},
    };
    setDaemonState(ctx.buffer, snapshot);
  } catch (err) {
    ctx.logger?.warn(
      { event: 'daemon_state.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist daemon state',
    );
  }
}

function persistDrainMetrics(
  ctx: DrainCycleContext,
  completedAt: string,
  durationMs: number,
  drainResult: DrainResult,
): void {
  try {
    const total = readNumberMetadata(ctx.buffer, METADATA_KEYS.drainCyclesTotal) + 1;
    setMetadata(ctx.buffer, METADATA_KEYS.drainCyclesTotal, total.toString());
    setMetadata(ctx.buffer, METADATA_KEYS.drainLastCycleAt, completedAt);
    setMetadata(ctx.buffer, METADATA_KEYS.drainLastCycleDurationMs, durationMs.toString());

    if (drainResult.retriable > 0 || drainResult.fatal > 0) {
      const errs = readNumberMetadata(ctx.buffer, METADATA_KEYS.drainCyclesWithErrors) + 1;
      setMetadata(ctx.buffer, METADATA_KEYS.drainCyclesWithErrors, errs.toString());
    }

    if (drainResult.accepted > 0) {
      const totBatches =
        readNumberMetadata(ctx.buffer, METADATA_KEYS.drainTotalBatchesShipped) +
        drainResult.accepted;
      setMetadata(ctx.buffer, METADATA_KEYS.drainTotalBatchesShipped, totBatches.toString());

      const totBytes =
        readNumberMetadata(ctx.buffer, METADATA_KEYS.drainTotalBytesShipped) +
        drainResult.acceptedBytes;
      setMetadata(ctx.buffer, METADATA_KEYS.drainTotalBytesShipped, totBytes.toString());

      const legacyBatches =
        readNumberMetadata(ctx.buffer, METADATA_KEYS.uploadTotalBatchesShipped) +
        drainResult.accepted;
      setMetadata(ctx.buffer, METADATA_KEYS.uploadTotalBatchesShipped, legacyBatches.toString());
      const legacyBytes =
        readNumberMetadata(ctx.buffer, METADATA_KEYS.uploadTotalBytesShipped) +
        drainResult.acceptedBytes;
      setMetadata(ctx.buffer, METADATA_KEYS.uploadTotalBytesShipped, legacyBytes.toString());

      setMetadata(ctx.buffer, METADATA_KEYS.uploadLastSuccessAt, completedAt);
      setMetadata(
        ctx.buffer,
        METADATA_KEYS.uploadLastSuccessBatches,
        drainResult.accepted.toString(),
      );
      setMetadata(
        ctx.buffer,
        METADATA_KEYS.uploadLastSuccessBytes,
        drainResult.acceptedBytes.toString(),
      );
      for (const [app, totals] of Object.entries(drainResult.acceptedBySource)) {
        if (totals === undefined) continue;
        const batchesKey = uploadBatchesShippedKey(app);
        const bytesKey = uploadBytesShippedKey(app);
        const prevBatches = readNumberMetadata(ctx.buffer, batchesKey);
        const prevBytes = readNumberMetadata(ctx.buffer, bytesKey);
        setMetadata(ctx.buffer, batchesKey, (prevBatches + totals.batches).toString());
        setMetadata(ctx.buffer, bytesKey, (prevBytes + totals.bytes).toString());
      }
    }
  } catch (err) {
    ctx.logger?.warn(
      { event: 'metrics.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist drain metrics',
    );
  }
}

function readNumberMetadata(buffer: DrainCycleContext['buffer'], key: string): number {
  const raw = getMetadata(buffer, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function finishSkip(
  startedAt: string,
  startMs: number,
  reason: 'auth_failed' | 'paused',
  log: DrainCycleContext['logger'],
  flags: { paused: boolean; authFailed: boolean },
): DrainCycleResult {
  const completedAt = nowIsoUtc();
  log?.info(
    { event: 'drain.cycle.skipped', reason },
    `drain cycle skipped: ${reason} sentinel present`,
  );
  return {
    paused: flags.paused,
    authFailed: flags.authFailed,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    drainResult: null,
    pruneResult: null,
    pressureResult: null,
  };
}
