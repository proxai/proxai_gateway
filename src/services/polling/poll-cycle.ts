import { runCaptureCycle } from 'services/polling/capture-cycle.ts';
import { runDrainCycle } from 'services/polling/drain-cycle.ts';
import type {
  CaptureCycleContext,
  DrainCycleContext,
  PollCycleContext,
  PollCycleResult,
} from 'services/polling/polling.types.ts';

export async function runPollCycle(ctx: PollCycleContext): Promise<PollCycleResult> {
  const captureCtx: CaptureCycleContext = {
    buffer: ctx.buffer,
    gatewayVersion: ctx.gatewayVersion,
    sources: ctx.sources,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
    bufferFullSentinelPath: ctx.bufferFullSentinelPath,
    bufferPolicy: ctx.bufferPolicy,
    capturePolicy: ctx.capturePolicy,
  };
  if (ctx.logger !== undefined) captureCtx.logger = ctx.logger;
  if (ctx.minimumMtimeOverride !== undefined) {
    captureCtx.minimumMtimeOverride = ctx.minimumMtimeOverride;
  }
  const captureResult = await runCaptureCycle(captureCtx);

  if (captureResult.authFailed || captureResult.bufferFull) {
    return {
      authFailed: captureResult.authFailed,
      bufferFull: captureResult.bufferFull,
      startedAt: captureResult.startedAt,
      completedAt: captureResult.completedAt,
      durationMs: captureResult.durationMs,
      sourceResults: captureResult.sourceResults,
      drainResult: null,
      pruneResult: null,
      pressureResult: captureResult.pressureResult,
    };
  }

  const drainCtx: DrainCycleContext = {
    buffer: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
    bufferFullSentinelPath: ctx.bufferFullSentinelPath,
    bufferPolicy: ctx.bufferPolicy,
  };
  if (ctx.logger !== undefined) drainCtx.logger = ctx.logger;
  if (ctx.pacer !== undefined) drainCtx.pacer = ctx.pacer;
  const drainResult = await runDrainCycle(drainCtx);

  return {
    authFailed: drainResult.authFailed,
    bufferFull: false,
    startedAt: captureResult.startedAt,
    completedAt: drainResult.completedAt,
    durationMs: Date.parse(drainResult.completedAt) - Date.parse(captureResult.startedAt),
    sourceResults: captureResult.sourceResults,
    drainResult: drainResult.drainResult,
    pruneResult: drainResult.pruneResult,
    pressureResult: drainResult.pressureResult ?? captureResult.pressureResult,
  };
}
