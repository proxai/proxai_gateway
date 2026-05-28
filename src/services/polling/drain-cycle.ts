import { createActor } from 'xstate';
import { nowIsoUtc } from 'core/utils';
import {
  checkPendingPressure,
  getDaemonState,
  getMetadata,
  pruneBuffer,
  setDaemonState,
  setMetadata,
} from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type { DaemonStateSnapshot, PruneResult } from 'services/buffer';
import type { PendingPressureResult } from 'services/buffer';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import { clearBufferFullSentinel, isBufferFull } from 'services/polling/buffer-full-sentinel.ts';
import type { DrainCycleContext, DrainCycleResult } from 'services/polling/polling.types.ts';
import { drainLoopMachine, type DrainGateBlockReason } from 'services/state-machines/drain-loop';
import { drainBuffer } from 'services/uploader';
import type { DrainResult } from 'services/uploader';

export async function runDrainCycle(ctx: DrainCycleContext): Promise<DrainCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  const cycleMachine = createActor(drainLoopMachine, { input: { intervalMs: 0 } });
  cycleMachine.start();
  cycleMachine.send({ type: 'TICK', startedAtUtc: startedAt });

  log?.info({ event: 'drain.cycle.start', started_at: startedAt }, 'drain cycle started');

  const gateReason = await evaluateGateReason(ctx);
  if (gateReason !== null) {
    cycleMachine.send({ type: 'GATE_BLOCKED', reason: gateReason });
    const skip = finishSkip(startedAt, startMs, gateReasonToSkipKey(gateReason), log, {
      authFailed: gateReason === 'auth',
    });
    cycleMachine.send({
      type: 'METRICS_PERSISTED',
      finishedAtUtc: skip.completedAt,
      durationMs: skip.durationMs,
    });
    cycleMachine.stop();
    return skip;
  }
  cycleMachine.send({ type: 'GATE_CLEAR' });

  const uploaderCtx: Parameters<typeof drainBuffer>[0] = {
    db: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
  };
  if (log !== undefined) uploaderCtx.logger = log;
  if (ctx.pacer !== undefined) uploaderCtx.pacer = ctx.pacer;
  const drainResult = await drainBuffer(uploaderCtx);
  cycleMachine.send({
    type: 'DRAIN_COMPLETE',
    accepted: drainResult.accepted,
    retriable: drainResult.retriable,
    fatal: drainResult.fatal,
    recovered: drainResult.recovered,
    acceptedBytes: drainResult.acceptedBytes,
    consecutiveRetriableBreak: drainResult.consecutiveRetriableBreak,
  });
  log?.info(
    {
      event: 'drain.complete',
      attempted: drainResult.attempted,
      accepted: drainResult.accepted,
      retriable: drainResult.retriable,
      fatal: drainResult.fatal,
      recovered: drainResult.recovered,
      retry_after_ms: drainResult.lastRetriableRetryAfterMs,
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
  cycleMachine.send({ type: 'PRUNE_COMPLETE' });

  const { pressureResult, clearedBufferFull } = await applyResumeSentinel(ctx, log);
  cycleMachine.send({ type: 'RESUME_EVALUATED', clearedBufferFull });

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'drain.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'drain cycle complete',
  );

  persistDaemonState(ctx, startedAt, completedAt, durationMs, drainResult);
  persistDrainMetrics(ctx, completedAt, durationMs, drainResult);
  cycleMachine.send({ type: 'METRICS_PERSISTED', finishedAtUtc: completedAt, durationMs });
  cycleMachine.stop();

  return {
    authFailed: false,
    startedAt,
    completedAt,
    durationMs,
    drainResult,
    pruneResult,
    pressureResult,
  };
}

async function evaluateGateReason(ctx: DrainCycleContext): Promise<DrainGateBlockReason | null> {
  if (await isAuthFailed(ctx.authFailedSentinelPath)) return 'auth';
  return null;
}

function gateReasonToSkipKey(_reason: DrainGateBlockReason): 'auth_failed' {
  return 'auth_failed';
}

async function applyResumeSentinel(
  ctx: DrainCycleContext,
  log: DrainCycleContext['logger'],
): Promise<{ pressureResult: PendingPressureResult; clearedBufferFull: boolean }> {
  const result = checkPendingPressure({
    db: ctx.buffer,
    softPauseBytes: ctx.bufferPolicy.softPauseBytes,
    softResumeBytes: ctx.bufferPolicy.softResumeBytes,
  });
  let clearedBufferFull = false;
  if (result.shouldResume) {
    const wasFull = await isBufferFull(ctx.bufferFullSentinelPath);
    if (wasFull) {
      await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
      clearedBufferFull = true;
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
  return { pressureResult: result, clearedBufferFull };
}

function persistDaemonState(
  ctx: DrainCycleContext,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  drainResult: DrainResult,
): void {
  try {
    const existing = getDaemonState(ctx.buffer);
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
      lastSourceCaptures: existing?.lastSourceCaptures ?? {},
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
  reason: 'auth_failed',
  log: DrainCycleContext['logger'],
  flags: { authFailed: boolean },
): DrainCycleResult {
  const completedAt = nowIsoUtc();
  log?.info(
    { event: 'drain.cycle.skipped', reason },
    `drain cycle skipped: ${reason} sentinel present`,
  );
  return {
    authFailed: flags.authFailed,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    drainResult: null,
    pruneResult: null,
    pressureResult: null,
  };
}
