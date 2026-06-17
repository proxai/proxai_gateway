import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb, insertBatch } from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';
import { HttpClient } from 'services/http';
import { runDaemonLoops } from 'services/polling';
import type {
  CaptureCycleContext,
  DrainCycleContext,
  HeartbeatCycleContext,
  RegisteredSource,
} from 'services/polling';
import { isAuthFailed, writeAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-daemon-loops-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function fakeFetch(): FetchFn {
  return async () =>
    new Response(JSON.stringify({ capture_id: 'irrelevant', accepted: true, idempotent: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

function noopSource(name: string): RegisteredSource {
  return {
    name,
    poll: async () => ({
      filesProcessed: 0,
      capturedBatches: 0,
      capturedBytes: 0,
      errors: [],
    }),
  };
}

function makeContexts(): {
  capture: CaptureCycleContext;
  drain: DrainCycleContext;
  heartbeat: HeartbeatCycleContext;
} {
  const captureCtx: CaptureCycleContext = {
    buffer,
    gatewayVersion: 'gw-0.1',
    sources: [noopSource('s')],
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
    capturePolicy: { maxDecompressedBytes: 9 * 1024 * 1024 },
  };
  const drainCtx: DrainCycleContext = {
    buffer,
    http: new HttpClient({
      apiKey: 'pxg_test',
      hostId: 'h_test',
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        verifyKey: 'https://api.example.com/ingestion/verify-key',
        watermarks: 'https://api.example.com/v1/watermarks',
        registerHostId: 'https://api.example.com/v1/host-ids/register',
      },
      fetch: fakeFetch(),
    }),
    hostId: 'h_test',
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
  };
  const heartbeatCtx: HeartbeatCycleContext = {
    buffer,
    gatewayVersion: 'gw-0.1',
    installedAt: new Date().toISOString(),
    staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
  };
  return { capture: captureCtx, drain: drainCtx, heartbeat: heartbeatCtx };
}

test('runs all three loops at least once and exits when abort signal fires', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  let captureCount = 0;
  let drainCount = 0;
  let heartbeatCount = 0;
  const promise = runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    authRecovery: { baseDelayMs: 1, idleMs: 1 },
    sleep: async (ms, signal) => {
      if (captureCount >= 1 && drainCount >= 1 && heartbeatCount >= 1) {
        ctrl.abort();
      }
      if (signal?.aborted === true) return;
      await new Promise((r) => setTimeout(r, ms));
    },
    onCaptureComplete: () => {
      captureCount++;
    },
    onDrainComplete: () => {
      drainCount++;
    },
    onHeartbeatComplete: () => {
      heartbeatCount++;
    },
  });
  await promise;
  expect(captureCount).toBeGreaterThanOrEqual(1);
  expect(drainCount).toBeGreaterThanOrEqual(1);
  expect(heartbeatCount).toBeGreaterThanOrEqual(1);
});

test('exits immediately when abort signal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const ctxs = makeContexts();
  await runDaemonLoops(ctxs, { abortSignal: ctrl.signal });
});

test('uses default intervals when not provided', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  let captureCount = 0;
  const promise = runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    sleep: async (_ms, signal) => {
      ctrl.abort();
      if (signal?.aborted === true) return;
    },
    onCaptureComplete: () => {
      captureCount++;
    },
  });
  await promise;
  expect(captureCount).toBeGreaterThanOrEqual(1);
});

test('callback errors are logged as warn but do not crash the loop', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  ctxs.capture.logger = fakeLogger;
  ctxs.drain.logger = fakeLogger;
  ctxs.heartbeat.logger = fakeLogger;
  const promise = runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    sleep: async (_ms, signal) => {
      ctrl.abort();
      if (signal?.aborted === true) return;
    },
    onCaptureComplete: () => {
      throw new Error('boom-cap');
    },
    onDrainComplete: () => {
      throw new Error('boom-drain');
    },
    onHeartbeatComplete: () => {
      throw new Error('boom-hb');
    },
  });
  await promise;
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('callback_failed'))).toBe(true);
});

test('drain-loop runtime error logs as error', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  ctxs.drain.logger = fakeLogger;
  buffer.close();
  let cycles = 0;
  const promise = runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    sleep: async (_ms, signal) => {
      cycles++;
      if (cycles >= 2) ctrl.abort();
      if (signal?.aborted === true) return;
    },
  });
  await promise;
  expect(entries.some((e) => e.level === 'error' && e.msg.includes('drain cycle threw'))).toBe(
    true,
  );
  buffer = (await import('services/buffer')).openInMemoryBufferDb();
});

test('runtime errors in cycle functions are logged as error and loops continue', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  ctxs.capture.logger = fakeLogger;
  ctxs.drain.logger = fakeLogger;
  ctxs.heartbeat.logger = fakeLogger;
  ctxs.capture.sources = [
    {
      name: 'broken',
      poll: async () => {
        throw new Error('source-explode');
      },
    },
  ];
  let cycles = 0;
  const promise = runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    sleep: async (_ms, signal) => {
      cycles++;
      if (cycles >= 2) ctrl.abort();
      if (signal?.aborted === true) return;
    },
  });
  await promise;
  expect(entries.some((e) => e.level === 'error' && e.msg.includes('capture cycle threw'))).toBe(
    true,
  );
});

test('pauses the loops (does not exit) while AUTH_FAILED is set, resuming on abort', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();

  await writeAuthFailedSentinel(ctxs.capture.authFailedSentinelPath, 'sentinel reason');

  let captureCount = 0;
  let drainCount = 0;
  let heartbeatCount = 0;
  let sleeps = 0;

  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    authRecovery: { baseDelayMs: 1, idleMs: 1, maxRetries: 2 },
    sleep: async (_ms, signal) => {
      sleeps++;
      if (sleeps >= 12) ctrl.abort();
      if (signal?.aborted === true) return;
    },
    onCaptureComplete: () => {
      captureCount++;
    },
    onDrainComplete: () => {
      drainCount++;
    },
    onHeartbeatComplete: () => {
      heartbeatCount++;
    },
  });

  // The loops stay paused while AUTH_FAILED is present — no cycles run — but the
  // daemon never exits on its own; it only unwinds when the abort signal fires.
  expect(captureCount).toBe(0);
  expect(drainCount).toBe(0);
  expect(heartbeatCount).toBe(0);
  expect(sleeps).toBeGreaterThanOrEqual(12);
});

test('auth-recovery re-verifies, clears AUTH_FAILED, and the paused loops resume', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  let verifyCalls = 0;
  // verify-key succeeds → the recovery loop should clear the sentinel and unpause.
  ctxs.drain.http = new HttpClient({
    apiKey: 'pxg_test',
    hostId: 'h_test',
    endpoints: {
      ingest: 'https://api.example.com/v1/raw_records',
      verifyKey: 'https://api.example.com/ingestion/verify-key',
      watermarks: 'https://api.example.com/v1/watermarks',
      registerHostId: 'https://api.example.com/v1/host-ids/register',
    },
    fetch: async () => {
      verifyCalls += 1;
      // stop the daemon as soon as the recovery loop re-verifies the key
      ctrl.abort();
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await writeAuthFailedSentinel(ctxs.capture.authFailedSentinelPath, 'transient backend blip');

  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    authRecovery: { baseDelayMs: 1, idleMs: 1 },
    // a real 1ms tick so the paused loops don't busy-spin past the recovery loop
    sleep: async (_ms, signal) => {
      if (signal?.aborted === true) return;
      await new Promise((r) => setTimeout(r, 1));
    },
  });

  // the verifyKey path ran and the sentinel was cleared → loops would resume
  expect(verifyCalls).toBeGreaterThanOrEqual(1);
  expect(await isAuthFailed(ctxs.capture.authFailedSentinelPath)).toBe(false);
});

interface FakeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => FakeLogger;
}

function makeFakeLogger(entries: { level: string; msg: string }[]): FakeLogger {
  function record(level: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const first = args[0];
      const last = args[args.length - 1];
      let msg = typeof last === 'string' ? last : JSON.stringify(last);
      if (args.length > 1 && typeof first === 'object' && first !== null) {
        msg = JSON.stringify(first) + ' ' + msg;
      }
      entries.push({ level, msg });
    };
  }
  const logger: FakeLogger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => logger,
  };
  return logger;
}

test('loops run (not paused) when no auth-failed sentinel path is set', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  delete (ctxs.drain as { authFailedSentinelPath?: string }).authFailedSentinelPath;
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  ctxs.drain.logger = fakeLogger;
  let cycles = 0;
  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    sleep: async (_ms, signal) => {
      cycles++;
      if (cycles >= 1) ctrl.abort();
      if (signal?.aborted === true) return;
    },
  });
  expect(cycles).toBeGreaterThanOrEqual(1);
});

test('daemon-loops unwinds when the abort signal flips between iterations', async () => {
  const ctxs = makeContexts();
  let calls = 0;
  const signal = {
    get aborted() {
      calls++;
      return calls > 1;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  await runDaemonLoops(ctxs, {
    abortSignal: signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
  });
  expect(calls).toBeGreaterThan(1);
});

test('supervised loops restart on unexpected error and continue if under crash limit', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  const entries: { level: string; msg: string }[] = [];
  const logger = makeFakeLogger(entries);
  ctxs.capture.logger = logger;
  ctxs.drain.logger = logger;
  ctxs.heartbeat.logger = logger;

  let sleepCount = 0;
  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 10000,
    heartbeatIntervalMs: 10000,
    sleep: async (ms, signal) => {
      sleepCount++;
      if (ms !== 1000 && sleepCount === 1) {
        throw new Error('unexpected crash');
      }
      ctrl.abort();
      if (signal?.aborted) return;
    },
  });

  const crashLogs = entries.filter((e) => e.msg.includes('loop crashed, restarting'));
  expect(crashLogs.length).toBeGreaterThanOrEqual(1);
});

test('supervised loops exit process when consecutive crash limit is reached', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  const entries: { level: string; msg: string }[] = [];
  const logger = makeFakeLogger(entries);
  ctxs.capture.logger = logger;
  ctxs.drain.logger = logger;
  ctxs.heartbeat.logger = logger;

  const origExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    ctrl.abort();
    throw new Error('process exited');
  }) as unknown as typeof process.exit;

  try {
    await runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 10000,
      sleep: async (ms) => {
        if (ms !== 1000) {
          throw new Error('always crash');
        }
      },
    });
  } catch (err) {
    expect((err as Error).message).toBe('process exited');
  } finally {
    process.exit = origExit;
  }

  expect(exitCode as unknown as number).toBe(1);
  const fatalLog = entries.find((e) => e.msg.includes('exiting process'));
  expect(fatalLog).toBeDefined();
});

test('supervised loops exit process when consecutive crash limit is reached (no fatal logger)', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  const entries: { level: string; msg: string }[] = [];
  const logger = makeFakeLogger(entries);
  delete (logger as { fatal?: unknown }).fatal;
  ctxs.capture.logger = logger;
  ctxs.drain.logger = logger;
  ctxs.heartbeat.logger = logger;

  const origExit = process.exit;
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    ctrl.abort();
    throw new Error('process exited');
  }) as unknown as typeof process.exit;

  try {
    await runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 10000,
      sleep: async (ms) => {
        if (ms !== 1000) {
          throw new Error('always crash');
        }
      },
    });
  } catch (err) {
    expect((err as Error).message).toBe('process exited');
  } finally {
    process.exit = origExit;
  }

  expect(exitCode as unknown as number).toBe(1);
  const fatalLog = entries.find((e) => e.msg.includes('exiting process'));
  expect(fatalLog).toBeDefined();
});

test('capture loop cycle timeout logs timeout event and continues', async () => {
  const origSetTimeout = globalThis.setTimeout;
  const entries: { level: string; msg: string }[] = [];
  const logger = makeFakeLogger(entries);

  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    if (ms === 90000) {
      return origSetTimeout(cb, 1);
    }
    return origSetTimeout(cb, ms);
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const ctrl = new AbortController();
    const ctxs = makeContexts();
    ctxs.capture.logger = logger;
    ctxs.capture.sources = [
      {
        name: 'hanging',
        poll: () => new Promise<never>(() => {}),
      },
    ];

    let sleepCalls = 0;
    await runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 10000,
      sleep: async (_ms, signal) => {
        sleepCalls++;
        if (sleepCalls >= 2) {
          ctrl.abort();
        }
        if (signal?.aborted) return;
      },
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }

  const timeoutEntry = entries.find((e) => e.msg.includes('capture cycle timed out'));
  expect(timeoutEntry).toBeDefined();
});

test('supervised loops reset crash count when running successfully for >10s', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  const entries: { level: string; msg: string }[] = [];
  const logger = makeFakeLogger(entries);
  ctxs.capture.logger = logger;
  ctxs.drain.logger = logger;
  ctxs.heartbeat.logger = logger;

  const origNow = Date.now;
  let shouldJump = false;
  Date.now = () => {
    const real = origNow();
    return shouldJump ? real + 20000 : real;
  };

  try {
    let sleepCount = 0;
    await runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 10000,
      sleep: async (ms, signal) => {
        sleepCount++;
        if (ms !== 1000 && sleepCount === 1) {
          shouldJump = true;
          throw new Error('unexpected crash');
        }
        ctrl.abort();
        if (signal?.aborted) return;
      },
    });
  } finally {
    Date.now = origNow;
  }

  const crashLogs = entries.filter((e) => e.msg.includes('loop crashed, restarting'));
  expect(crashLogs.length).toBeGreaterThanOrEqual(1);
  expect(crashLogs[0]?.msg).toContain('"consecutiveCrashes":1');
});

test('heartbeat loop cycle error logs error event and continues', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();
  const entries: { level: string; msg: string }[] = [];
  ctxs.heartbeat.logger = makeFakeLogger(entries);

  const heartbeatBuffer = openInMemoryBufferDb();
  heartbeatBuffer.close();
  ctxs.heartbeat.buffer = heartbeatBuffer;
  delete (ctxs.heartbeat as { staleBinary?: unknown }).staleBinary;

  let sleepCalls = 0;
  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 10000,
    drainIntervalMs: 10000,
    heartbeatIntervalMs: 1,
    sleep: async (ms, signal) => {
      sleepCalls++;
      if (sleepCalls > 50 || entries.some((e) => e.msg.includes('heartbeat cycle threw'))) {
        ctrl.abort();
      }
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, Math.min(ms, 2)));
    },
  });

  const errorEntry = entries.find((e) => e.msg.includes('heartbeat cycle threw'));
  expect(errorEntry).toBeDefined();
});

test('capture loop re-entrancy guard: skips if prior run is still in flight', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    if (ms === 90000) {
      return origSetTimeout(cb, 1);
    }
    return origSetTimeout(cb, ms);
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const ctrl = new AbortController();
    const ctxs = makeContexts();
    const entries: { level: string; msg: string }[] = [];
    const logger = makeFakeLogger(entries);
    ctxs.capture.logger = logger;

    let resolveCycle: ((res: import('services/polling').SourcePollerResult) => void) | null = null;
    let cycleCallCount = 0;

    ctxs.capture.sources = [
      {
        name: 'delayed',
        poll: async () => {
          cycleCallCount++;
          return new Promise((resolve) => {
            resolveCycle = resolve;
          });
        },
      },
    ];

    let captureTicks = 0;
    const promise = runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 10000,
      sleep: async (ms, signal) => {
        if (ms === 1) {
          captureTicks++;
          if (captureTicks === 1) {
            await new Promise((r) => setTimeout(r, 10));
          } else if (captureTicks === 2) {
            if (resolveCycle) {
              resolveCycle({
                filesProcessed: 0,
                capturedBatches: 0,
                capturedBytes: 0,
                errors: [],
              });
            }
            ctrl.abort();
          }
        } else {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            let active = true;
            const safeResolve = () => {
              if (active) {
                active = false;
                resolve();
              }
            };
            const t = setTimeout(safeResolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              safeResolve();
            });
          });
        }
      },
    });

    await promise;

    expect(cycleCallCount).toBe(1);
    const skippedLog = entries.find((e) => e.msg.includes('capture.cycle.skipped_in_flight'));
    expect(skippedLog).toBeDefined();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('drain loop re-entrancy guard: skips if prior run is still in flight', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    if (ms === 25000) {
      return origSetTimeout(cb, 1);
    }
    return origSetTimeout(cb, ms);
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const ctrl = new AbortController();
    const ctxs = makeContexts();
    const entries: { level: string; msg: string }[] = [];
    const logger = makeFakeLogger(entries);
    ctxs.drain.logger = logger;

    let resolveFetch: ((res: Response) => void) | null = null;
    ctxs.drain.http = new HttpClient({
      apiKey: 'pxg_test',
      hostId: 'h_test',
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        verifyKey: 'https://api.example.com/ingestion/verify-key',
        watermarks: 'https://api.example.com/v1/watermarks',
        registerHostId: 'https://api.example.com/v1/host-ids/register',
      },
      fetch: async () => {
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    insertBatch(ctxs.drain.buffer, newBatch());

    let drainTicks = 0;
    const promise = runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 10000,
      drainIntervalMs: 1,
      heartbeatIntervalMs: 10000,
      sleep: async (ms, signal) => {
        if (ms === 1) {
          drainTicks++;
          if (drainTicks === 1) {
            await new Promise((r) => setTimeout(r, 10));
          } else if (drainTicks === 2) {
            if (resolveFetch) {
              resolveFetch(
                new Response(JSON.stringify({ accepted: true }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              );
            }
            ctrl.abort();
          }
        } else {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            let active = true;
            const safeResolve = () => {
              if (active) {
                active = false;
                resolve();
              }
            };
            const t = setTimeout(safeResolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              safeResolve();
            });
          });
        }
      },
    });

    await promise;

    const skippedLog = entries.find((e) => e.msg.includes('drain.cycle.skipped_in_flight'));
    expect(skippedLog).toBeDefined();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('heartbeat loop re-entrancy guard: skips if prior run is still in flight', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: () => void, ms: number) => {
    if (ms === 600000) {
      return origSetTimeout(cb, 1);
    }
    return origSetTimeout(cb, ms);
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const ctrl = new AbortController();
    const ctxs = makeContexts();
    const entries: { level: string; msg: string }[] = [];
    const logger = makeFakeLogger(entries);
    ctxs.heartbeat.logger = logger;

    ctxs.heartbeat.binaryPath = '/bin/gateway';
    ctxs.heartbeat.currentVersion = '1.0.0';
    let resolveFetch: ((res: Response) => void) | null = null;
    ctxs.heartbeat.versionCheckFetch = async () => {
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };

    let heartbeatTicks = 0;
    const promise = runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 10000,
      drainIntervalMs: 10000,
      heartbeatIntervalMs: 1,
      sleep: async (ms, signal) => {
        if (ms === 1) {
          heartbeatTicks++;
          if (heartbeatTicks === 1) {
            await new Promise((r) => setTimeout(r, 10));
          } else if (heartbeatTicks === 2) {
            if (resolveFetch) {
              resolveFetch(
                new Response(JSON.stringify({ tag_name: 'v1.0.0' }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              );
            }
            ctrl.abort();
          }
        } else {
          if (signal?.aborted) return;
          await new Promise<void>((resolve) => {
            let active = true;
            const safeResolve = () => {
              if (active) {
                active = false;
                resolve();
              }
            };
            const t = setTimeout(safeResolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              safeResolve();
            });
          });
        }
      },
    });

    await promise;

    const skippedLog = entries.find((e) => e.msg.includes('heartbeat.cycle.skipped_in_flight'));
    expect(skippedLog).toBeDefined();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('daemon loops log daemon.resumed on sleep overrun', async () => {
  const origNow = Date.now;
  try {
    const ctrl = new AbortController();
    const ctxs = makeContexts();
    const entries: Array<{ level: string; msg: string; event?: string }> = [];
    const logger = makeFakeLogger(entries);
    ctxs.capture.logger = logger;
    ctxs.drain.logger = logger;
    ctxs.heartbeat.logger = logger;

    ctxs.heartbeat.binaryPath = '/bin/gateway';
    ctxs.heartbeat.currentVersion = '1.0.0';

    let heartbeatCount = 0;
    let fakeNow = Date.now();
    Date.now = () => fakeNow;

    const promise = runDaemonLoops(ctxs, {
      abortSignal: ctrl.signal,
      captureIntervalMs: 1,
      drainIntervalMs: 1,
      heartbeatIntervalMs: 1,
      onHeartbeatComplete: () => {
        heartbeatCount++;
      },
      sleep: async (ms, signal) => {
        if (signal?.aborted) return;
        fakeNow += ms + 200_000;
        if (heartbeatCount >= 2) {
          ctrl.abort();
        }
        await new Promise((r) => setTimeout(r, 1));
      },
    });

    await promise;

    const resumedLogs = entries.filter((e) => e.msg.includes('daemon.resumed'));
    expect(resumedLogs.length).toBeGreaterThanOrEqual(1);
  } finally {
    Date.now = origNow;
  }
});
