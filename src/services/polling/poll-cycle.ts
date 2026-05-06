import { nowIsoUtc } from 'core/utils';
import { drainBuffer } from 'services/uploader';
import { isPaused } from 'services/polling/pause-sentinel.ts';
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

  if (await isPaused(ctx.pauseSentinelPath)) {
    const completedAt = nowIsoUtc();
    log?.info({ event: 'cycle.paused' }, 'poll cycle skipped: paused sentinel present');
    return {
      paused: true,
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
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    drainResult,
  };
}
