import { nowIsoUtc } from 'core/utils';
import { checkPendingPressure, pruneBuffer } from 'services/buffer';
import type { PendingPressureResult, PruneResult } from 'services/buffer';
import { drainBuffer } from 'services/uploader';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import {
  clearBufferFullSentinel,
  isBufferFull,
  writeBufferFullSentinel,
} from 'services/polling/buffer-full-sentinel.ts';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import { checkStaleBinary } from 'services/polling/stale-binary.ts';
import type {
  PollCycleContext,
  PollCycleResult,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export async function runPollCycle(ctx: PollCycleContext): Promise<PollCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  log?.info({ event: 'cycle.start', started_at: startedAt }, 'poll cycle started');

  if (await isAuthFailed(ctx.authFailedSentinelPath)) {
    const completedAt = nowIsoUtc();
    log?.warn({ event: 'cycle.auth_failed' }, 'poll cycle skipped: auth-failed sentinel present');
    return {
      paused: false,
      authFailed: true,
      bufferFull: false,
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
      pruneResult: null,
      pressureResult: null,
    };
  }

  if (await isBufferFull(ctx.bufferFullSentinelPath)) {
    // Sentinel is present. Attempt a cheap recovery: if pending pressure has
    // dropped below the resume threshold, clear the sentinel and proceed with
    // the cycle. Otherwise, short-circuit.
    const recovery = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (recovery.shouldResume) {
      await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
      log?.info(
        {
          event: 'buffer.soft_resume',
          pending_bytes: recovery.pendingBytes,
          threshold: ctx.bufferPolicy.softResumeBytes,
        },
        'buffer pending pressure dropped below resume threshold; sentinel cleared at cycle start',
      );
    } else {
      const completedAt = nowIsoUtc();
      log?.warn(
        {
          event: 'cycle.buffer_full',
          pending_bytes: recovery.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'poll cycle skipped: buffer-full sentinel present',
      );
      return {
        paused: false,
        authFailed: false,
        bufferFull: true,
        startedAt,
        completedAt,
        durationMs: Date.now() - startMs,
        sourceResults: {},
        drainResult: null,
        pruneResult: null,
        pressureResult: recovery,
      };
    }
  }

  const staleDeps: Parameters<typeof checkStaleBinary>[0] = {
    installedAt: ctx.installedAt,
    warnAfterDays: ctx.staleBinary.warnAfterDays,
    pauseAfterDays: ctx.staleBinary.pauseAfterDays,
    pauseSentinelPath: ctx.pauseSentinelPath,
  };
  if (log !== undefined) staleDeps.logger = log;
  await checkStaleBinary(staleDeps);

  if (await isPaused(ctx.pauseSentinelPath)) {
    const completedAt = nowIsoUtc();
    log?.info({ event: 'cycle.paused' }, 'poll cycle skipped: paused sentinel present');
    return {
      paused: true,
      authFailed: false,
      bufferFull: false,
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
      pruneResult: null,
      pressureResult: null,
    };
  }

  const sourceResults: Record<string, SourcePollerResult> = {};
  for (const source of ctx.sources) {
    const sourceLog = log?.child({ source_app: source.name });
    sourceLog?.debug({ event: 'source.poll.start' }, 'source poll started');
    const sourceCtx: SourcePollerContext = {
      buffer: ctx.buffer,
      gatewayVersion: ctx.gatewayVersion,
    };
    if (sourceLog !== undefined) sourceCtx.logger = sourceLog;
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
      sourceLog?.warn(
        { event: 'source.poll.error', source_path: err.sourcePath, reason: err.reason },
        'source poll captured an error',
      );
    }
  }

  log?.debug({ event: 'drain.start' }, 'buffer drain started');
  const uploaderCtx: Parameters<typeof drainBuffer>[0] = {
    db: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
  };
  if (log !== undefined) uploaderCtx.logger = log;
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
      'buffer prune failed; continuing cycle',
    );
  }

  let pressureResult: PendingPressureResult | null = null;
  try {
    pressureResult = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (pressureResult.shouldPause) {
      await writeBufferFullSentinel(ctx.bufferFullSentinelPath, {
        pendingBytes: pressureResult.pendingBytes,
        threshold: ctx.bufferPolicy.softPauseBytes,
      });
      log?.warn(
        {
          event: 'buffer.soft_pause',
          pending_bytes: pressureResult.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'buffer pending pressure exceeded soft-pause threshold; sentinel written',
      );
    } else if (pressureResult.shouldResume) {
      const wasFull = await isBufferFull(ctx.bufferFullSentinelPath);
      if (wasFull) {
        await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
        log?.info(
          {
            event: 'buffer.soft_resume',
            pending_bytes: pressureResult.pendingBytes,
            threshold: ctx.bufferPolicy.softResumeBytes,
          },
          'buffer pending pressure dropped below resume threshold; sentinel cleared',
        );
      }
    }
  } catch (err) {
    log?.warn(
      { event: 'buffer.pressure_failed', error: (err as Error).message ?? String(err) },
      'buffer pressure check failed; continuing cycle',
    );
  }

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    {
      event: 'cycle.complete',
      duration_ms: durationMs,
      completed_at: completedAt,
    },
    'poll cycle complete',
  );
  return {
    paused: false,
    authFailed: false,
    bufferFull: false,
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    drainResult,
    pruneResult,
    pressureResult,
  };
}
