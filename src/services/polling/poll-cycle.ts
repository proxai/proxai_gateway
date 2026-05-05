import { nowIsoUtc } from 'core/utils';
import { drainBuffer } from 'services/uploader';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import type {
  PollCycleContext,
  PollCycleResult,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export async function runPollCycle(ctx: PollCycleContext): Promise<PollCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();

  if (await isPaused(ctx.pauseSentinelPath)) {
    const completedAt = nowIsoUtc();
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
    sourceResults[source.name] = await source.poll({
      buffer: ctx.buffer,
      gatewayVersion: ctx.gatewayVersion,
    });
  }

  const drainResult = await drainBuffer({
    db: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
  });

  const completedAt = nowIsoUtc();
  return {
    paused: false,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    sourceResults,
    drainResult,
  };
}
