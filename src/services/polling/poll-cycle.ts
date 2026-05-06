import { nowIsoUtc } from 'core/utils';
import { drainBuffer } from 'services/uploader';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
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
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
    };
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
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
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
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    drainResult,
  };
}
