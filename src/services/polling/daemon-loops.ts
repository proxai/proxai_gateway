import { dirname, join } from 'node:path';
import { abortableSleep, nowIsoUtc } from 'core/utils';
import { startDaemonActors } from 'services/state-machines/daemon-actors';
import type { DaemonActorsHandle } from 'services/state-machines/daemon-actors';
import { runCaptureCycle } from 'services/polling/capture-cycle.ts';
import { runDrainCycle } from 'services/polling/drain-cycle.ts';
import { runHeartbeatCycle } from 'services/polling/heartbeat-cycle.ts';
import {
  CAPTURE_INTERVAL_MS,
  DRAIN_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from 'services/polling/polling.constants.ts';
import type {
  CaptureCycleContext,
  CaptureCycleResult,
  DaemonLoopOptions,
  DrainCycleContext,
  DrainCycleResult,
  HeartbeatCycleContext,
  HeartbeatCycleResult,
} from 'services/polling/polling.types.ts';

export interface DaemonLoopContexts {
  capture: CaptureCycleContext;
  drain: DrainCycleContext;
  heartbeat: HeartbeatCycleContext;
}

export async function runDaemonLoops(
  contexts: DaemonLoopContexts,
  options: DaemonLoopOptions = {},
): Promise<void> {
  const captureMs = options.captureIntervalMs ?? CAPTURE_INTERVAL_MS;
  const drainMs = options.drainIntervalMs ?? DRAIN_INTERVAL_MS;
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.abortSignal;

  const handle = await bootDaemonActors(contexts, options.xstateInspect);

  try {
    handle.markReady(nowIsoUtc());
    await Promise.all([
      captureLoop(contexts.capture, captureMs, signal, sleep, options.onCaptureComplete),
      drainLoop(contexts.drain, drainMs, signal, sleep, options.onDrainComplete),
      heartbeatLoop(contexts.heartbeat, heartbeatMs, signal, sleep, options.onHeartbeatComplete),
    ]);
  } finally {
    handle.requestShutdown('sigterm');
    handle.markExited(nowIsoUtc());
    await handle.stop();
  }
}

async function bootDaemonActors(
  contexts: DaemonLoopContexts,
  xstateInspect?: boolean,
): Promise<DaemonActorsHandle> {
  const configDir = dirname(contexts.capture.authFailedSentinelPath);
  const input: Parameters<typeof startDaemonActors>[0] = {
    buffer: contexts.capture.buffer,
    paths: {
      configDir,
      authFailed: contexts.capture.authFailedSentinelPath,
      bufferFull: contexts.capture.bufferFullSentinelPath,
      sessionStopped: join(configDir, 'SESSION_STOPPED'),
      updateAvailable:
        contexts.heartbeat.updateAvailableSentinelPath ?? join(configDir, 'UPDATE_AVAILABLE'),
    },
    ...(xstateInspect !== undefined ? { xstateInspect } : {}),
    ...(contexts.capture.logger !== undefined ? { logger: contexts.capture.logger } : {}),
  };
  return startDaemonActors(input);
}

async function captureLoop(
  ctx: CaptureCycleContext,
  intervalMs: number,
  signal: AbortSignal | undefined,
  sleep: NonNullable<DaemonLoopOptions['sleep']>,
  onComplete: ((result: CaptureCycleResult) => void) | undefined,
): Promise<void> {
  while (!isAborted(signal)) {
    try {
      const result = await runCaptureCycle(ctx);
      notify(onComplete, result, ctx.logger, 'capture.cycle.callback_failed');
    } catch (err) {
      ctx.logger?.error(
        { event: 'capture.cycle.error', error: (err as Error).message ?? String(err) },
        'capture cycle threw',
      );
    }
    if (isAborted(signal)) return;
    await sleep(intervalMs, signal);
  }
}

async function drainLoop(
  ctx: DrainCycleContext,
  intervalMs: number,
  signal: AbortSignal | undefined,
  sleep: NonNullable<DaemonLoopOptions['sleep']>,
  onComplete: ((result: DrainCycleResult) => void) | undefined,
): Promise<void> {
  while (!isAborted(signal)) {
    try {
      const result = await runDrainCycle(ctx);
      notify(onComplete, result, ctx.logger, 'drain.cycle.callback_failed');
    } catch (err) {
      ctx.logger?.error(
        { event: 'drain.cycle.error', error: (err as Error).message ?? String(err) },
        'drain cycle threw',
      );
    }
    if (isAborted(signal)) return;
    await sleep(intervalMs, signal);
  }
}

async function heartbeatLoop(
  ctx: HeartbeatCycleContext,
  intervalMs: number,
  signal: AbortSignal | undefined,
  sleep: NonNullable<DaemonLoopOptions['sleep']>,
  onComplete: ((result: HeartbeatCycleResult) => void) | undefined,
): Promise<void> {
  while (!isAborted(signal)) {
    const result = await runHeartbeatCycle(ctx);
    notify(onComplete, result, ctx.logger, 'heartbeat.cycle.callback_failed');
    if (isAborted(signal)) return;
    await sleep(intervalMs, signal);
  }
}

function notify<T>(
  cb: ((result: T) => void) | undefined,
  result: T,
  logger: { warn: (...args: unknown[]) => void } | undefined,
  errorEvent: string,
): void {
  if (cb === undefined) return;
  try {
    cb(result);
  } catch (err) {
    logger?.warn({ event: errorEvent, error: (err as Error).message ?? String(err) });
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
