import { dirname, join } from 'node:path';
import { abortableSleep, nowIsoUtc } from 'core/utils';
import { startDaemonActors } from 'services/state-machines/daemon-actors';
import type { DaemonActorsHandle } from 'services/state-machines/daemon-actors';
import { runCaptureCycle } from 'services/polling/capture-cycle.ts';
import { runDrainCycle } from 'services/polling/drain-cycle.ts';
import { runHeartbeatCycle } from 'services/polling/heartbeat-cycle.ts';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import { runAuthRecoveryLoop } from 'services/polling/auth-recovery.ts';
import {
  CAPTURE_INTERVAL_MS,
  DRAIN_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  PAUSE_RECHECK_MS,
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
    contexts.heartbeat.authFailedSentinelPath = contexts.capture.authFailedSentinelPath;
    await Promise.all([
      superviseLoop(
        'capture',
        () => captureLoop(contexts.capture, captureMs, signal, sleep, options.onCaptureComplete),
        contexts.capture.logger,
        sleep,
        signal,
      ),
      superviseLoop(
        'drain',
        () => drainLoop(contexts.drain, drainMs, signal, sleep, options.onDrainComplete),
        contexts.drain.logger,
        sleep,
        signal,
      ),
      superviseLoop(
        'heartbeat',
        () =>
          heartbeatLoop(
            contexts.heartbeat,
            heartbeatMs,
            signal,
            sleep,
            options.onHeartbeatComplete,
          ),
        contexts.heartbeat.logger,
        sleep,
        signal,
      ),
      superviseLoop(
        'auth_recovery',
        () =>
          runAuthRecoveryLoop(
            {
              verifyKey: () => contexts.drain.http.verifyKey(),
              authFailedSentinelPath: contexts.capture.authFailedSentinelPath,
              ...(contexts.drain.logger !== undefined ? { logger: contexts.drain.logger } : {}),
            },
            { sleep, abortSignal: signal, ...options.authRecovery },
          ),
        contexts.drain.logger,
        sleep,
        signal,
      ),
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

async function superviseLoop(
  name: string,
  loopFn: () => Promise<void>,
  logger: { error: (...args: unknown[]) => void; fatal?: (...args: unknown[]) => void } | undefined,
  sleep: NonNullable<DaemonLoopOptions['sleep']>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let consecutiveCrashes = 0;
  const maxCrashes = 3;
  while (signal === undefined || !signal.aborted) {
    const startTime = Date.now();
    try {
      await loopFn();
      break;
    } catch (err) {
      if (signal?.aborted) {
        break;
      }
      const elapsed = Date.now() - startTime;
      if (elapsed > 10_000) {
        consecutiveCrashes = 0;
      }
      consecutiveCrashes++;
      logger?.error(
        {
          event: `${name}.loop.crashed`,
          error: (err as Error).message ?? String(err),
          consecutiveCrashes,
        },
        `${name} loop crashed, restarting`,
      );
      if (consecutiveCrashes >= maxCrashes) {
        if (logger?.fatal) {
          logger.fatal(
            { event: 'daemon.fatal_crash_limit', loop: name },
            `${name} loop crashed consecutively ${consecutiveCrashes} times, exiting process`,
          );
        } else {
          logger?.error(
            { event: 'daemon.fatal_crash_limit', loop: name },
            `${name} loop crashed consecutively ${consecutiveCrashes} times, exiting process`,
          );
        }
        process.exit(1);
      }
      await sleep(1000, signal);
    }
  }
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  eventPrefix: string,
  logger: { error: (...args: unknown[]) => void } | undefined,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger?.error({ event: `${eventPrefix}.cycle.timeout` }, `${eventPrefix} cycle timed out`);
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function captureLoop(
  ctx: CaptureCycleContext,
  intervalMs: number,
  signal: AbortSignal | undefined,
  sleep: NonNullable<DaemonLoopOptions['sleep']>,
  onComplete: ((result: CaptureCycleResult) => void) | undefined,
): Promise<void> {
  while (!isAborted(signal)) {
    if (await pausedByAuth(ctx.authFailedSentinelPath)) {
      await sleep(Math.min(intervalMs, PAUSE_RECHECK_MS), signal);
      continue;
    }
    try {
      const result = await runWithTimeout(runCaptureCycle(ctx), 90_000, 'capture', ctx.logger);
      if (result !== null) {
        notify(onComplete, result, ctx.logger, 'capture.cycle.callback_failed');
      }
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
    if (await pausedByAuth(ctx.authFailedSentinelPath)) {
      await sleep(Math.min(intervalMs, PAUSE_RECHECK_MS), signal);
      continue;
    }
    try {
      const result = await runWithTimeout(runDrainCycle(ctx), 25_000, 'drain', ctx.logger);
      if (result !== null) {
        notify(onComplete, result, ctx.logger, 'drain.cycle.callback_failed');
      }
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
    if (await pausedByAuth(ctx.authFailedSentinelPath)) {
      await sleep(Math.min(intervalMs, PAUSE_RECHECK_MS), signal);
      continue;
    }
    try {
      const result = await runWithTimeout(runHeartbeatCycle(ctx), 600_000, 'heartbeat', ctx.logger);
      if (result !== null) {
        notify(onComplete, result, ctx.logger, 'heartbeat.cycle.callback_failed');
      }
    } catch (err) {
      ctx.logger?.error(
        { event: 'heartbeat.cycle.error', error: (err as Error).message ?? String(err) },
        'heartbeat cycle threw',
      );
    }
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

async function pausedByAuth(sentinelPath: string | undefined): Promise<boolean> {
  if (sentinelPath === undefined) {
    return false;
  }
  return isAuthFailed(sentinelPath);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
