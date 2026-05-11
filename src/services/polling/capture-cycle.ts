import { nowIsoUtc } from 'core/utils';
import {
  checkPendingPressure,
  getDaemonState,
  getMetadata,
  setDaemonState,
  setMetadata,
} from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type {
  DaemonStateSnapshot,
  PendingPressureResult,
  SourceCycleResult,
} from 'services/buffer';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import { isBufferFull, writeBufferFullSentinel } from 'services/polling/buffer-full-sentinel.ts';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import type {
  CaptureCycleContext,
  CaptureCycleResult,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export async function runCaptureCycle(ctx: CaptureCycleContext): Promise<CaptureCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  log?.info({ event: 'capture.cycle.start', started_at: startedAt }, 'capture cycle started');

  if (await isAuthFailed(ctx.authFailedSentinelPath)) {
    return finishSkip(startedAt, startMs, 'auth_failed', log, {
      authFailed: true,
      paused: false,
      bufferFull: false,
    });
  }
  if (await isPaused(ctx.pauseSentinelPath)) {
    return finishSkip(startedAt, startMs, 'paused', log, {
      authFailed: false,
      paused: true,
      bufferFull: false,
    });
  }
  if (await isBufferFull(ctx.bufferFullSentinelPath)) {
    return finishSkip(startedAt, startMs, 'buffer_full', log, {
      authFailed: false,
      paused: false,
      bufferFull: true,
    });
  }

  const sourceResults: Record<string, SourcePollerResult> = {};
  for (const source of ctx.sources) {
    const sourceLog = log?.child({ source_app: source.name });
    sourceLog?.debug({ event: 'source.poll.start' }, 'source poll started');
    const sourceCtx: SourcePollerContext = {
      buffer: ctx.buffer,
      gatewayVersion: ctx.gatewayVersion,
      maxDecompressedBytes: ctx.capturePolicy.maxDecompressedBytes,
    };
    if (sourceLog !== undefined) sourceCtx.logger = sourceLog;
    if (ctx.minimumMtimeOverride !== undefined) {
      sourceCtx.minimumMtimeOverride = ctx.minimumMtimeOverride;
    }
    const result = await source.poll(sourceCtx);
    sourceResults[source.name] = result;
    sourceLog?.info(
      {
        event: 'source.poll.complete',
        files_processed: result.filesProcessed,
        captured_batches: result.capturedBatches,
        captured_bytes: result.capturedBytes,
        errors_count: result.errors.length,
      },
      'source poll complete',
    );
    for (const err of result.errors) {
      sourceLog?.error(
        { event: 'source.poll.error', source_path: err.sourcePath, reason: err.reason },
        'source poll captured an error',
      );
    }
  }

  const pressureResult = await applyPressureSentinel(ctx, log);

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'capture.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'capture cycle complete',
  );

  persistCaptureMetrics(ctx, completedAt, durationMs, sourceResults);
  persistSourceCaptures(ctx, sourceResults);

  return {
    paused: false,
    authFailed: false,
    bufferFull: false,
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    pressureResult,
  };
}

function toSourceCycleResult(result: SourcePollerResult): SourceCycleResult {
  return {
    filesProcessed: result.filesProcessed,
    capturedBatches: result.capturedBatches,
    capturedBytes: result.capturedBytes,
    errorsCount: result.errors.length,
  };
}

function persistSourceCaptures(
  ctx: CaptureCycleContext,
  sourceResults: Record<string, SourcePollerResult>,
): void {
  try {
    const existing = getDaemonState(ctx.buffer);
    const captures: Record<string, SourceCycleResult> = {
      ...existing?.lastSourceCaptures,
    };
    for (const [name, result] of Object.entries(sourceResults)) {
      captures[name] = toSourceCycleResult(result);
    }
    const snapshot: DaemonStateSnapshot = {
      lastCycleStartedAt: existing?.lastCycleStartedAt ?? null,
      lastCycleCompletedAt: existing?.lastCycleCompletedAt ?? null,
      lastCycleDurationMs: existing?.lastCycleDurationMs ?? null,
      lastDrainAttempted: existing?.lastDrainAttempted ?? null,
      lastDrainAccepted: existing?.lastDrainAccepted ?? null,
      lastDrainRetriable: existing?.lastDrainRetriable ?? null,
      lastDrainFatal: existing?.lastDrainFatal ?? null,
      lastDrainRecovered: existing?.lastDrainRecovered ?? null,
      lastUploadError: existing?.lastUploadError ?? null,
      lastConsecutiveRetriableBreak: existing?.lastConsecutiveRetriableBreak ?? null,
      lastSourceCaptures: captures,
    };
    setDaemonState(ctx.buffer, snapshot);
  } catch (err) {
    ctx.logger?.warn(
      { event: 'daemon_state.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist daemon state from capture cycle',
    );
  }
}

async function applyPressureSentinel(
  ctx: CaptureCycleContext,
  log: CaptureCycleContext['logger'],
): Promise<PendingPressureResult | null> {
  try {
    const result = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (result.shouldPause) {
      await writeBufferFullSentinel(ctx.bufferFullSentinelPath, {
        pendingBytes: result.pendingBytes,
        threshold: ctx.bufferPolicy.softPauseBytes,
      });
      log?.warn(
        {
          event: 'buffer.soft_pause',
          pending_bytes: result.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'buffer pending pressure exceeded soft-pause threshold; sentinel written',
      );
    }
    return result;
  } catch (err) {
    log?.warn(
      { event: 'buffer.pressure_failed', error: (err as Error).message ?? String(err) },
      'buffer pressure check failed; continuing capture',
    );
    return null;
  }
}

function persistCaptureMetrics(
  ctx: CaptureCycleContext,
  completedAt: string,
  durationMs: number,
  sourceResults: Record<string, SourcePollerResult>,
): void {
  try {
    const total = readNumberMetadata(ctx.buffer, METADATA_KEYS.captureCyclesTotal) + 1;
    setMetadata(ctx.buffer, METADATA_KEYS.captureCyclesTotal, total.toString());
    setMetadata(ctx.buffer, METADATA_KEYS.captureLastCycleAt, completedAt);
    setMetadata(ctx.buffer, METADATA_KEYS.captureLastCycleDurationMs, durationMs.toString());
    const hadErrors = Object.values(sourceResults).some((r) => r.errors.length > 0);
    if (hadErrors) {
      const errs = readNumberMetadata(ctx.buffer, METADATA_KEYS.captureCyclesWithErrors) + 1;
      setMetadata(ctx.buffer, METADATA_KEYS.captureCyclesWithErrors, errs.toString());
    }
  } catch (err) {
    ctx.logger?.warn(
      { event: 'metrics.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist capture metrics',
    );
  }
}

function readNumberMetadata(buffer: CaptureCycleContext['buffer'], key: string): number {
  const raw = getMetadata(buffer, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function finishSkip(
  startedAt: string,
  startMs: number,
  reason: 'auth_failed' | 'paused' | 'buffer_full',
  log: CaptureCycleContext['logger'],
  flags: { paused: boolean; authFailed: boolean; bufferFull: boolean },
): CaptureCycleResult {
  const completedAt = nowIsoUtc();
  log?.info(
    { event: 'capture.cycle.skipped', reason },
    `capture cycle skipped: ${reason} sentinel present`,
  );
  return {
    paused: flags.paused,
    authFailed: flags.authFailed,
    bufferFull: flags.bufferFull,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    sourceResults: {},
    pressureResult: null,
  };
}
