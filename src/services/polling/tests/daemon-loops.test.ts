import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb } from 'services/buffer';
import { HttpClient } from 'services/http';
import { runDaemonLoops } from 'services/polling';
import type {
  CaptureCycleContext,
  DrainCycleContext,
  HeartbeatCycleContext,
  RegisteredSource,
} from 'services/polling';
import { writeAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';

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

test('gracefully exits the loops when shouldHalt (sentinel present) resolves to true', async () => {
  const ctrl = new AbortController();
  const ctxs = makeContexts();

  await writeAuthFailedSentinel(ctxs.capture.authFailedSentinelPath, 'sentinel reason');

  let captureCount = 0;
  let drainCount = 0;
  let heartbeatCount = 0;

  await runDaemonLoops(ctxs, {
    abortSignal: ctrl.signal,
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
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

  expect(captureCount).toBe(0);
  expect(drainCount).toBe(0);
  expect(heartbeatCount).toBe(0);
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
      const last = args[args.length - 1];
      const msg = typeof last === 'string' ? last : JSON.stringify(last);
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

test('shouldHalt returns false when no sentinel path is set and signal is live', async () => {
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

test('daemon-loops covers shouldHalt when signal is aborted inside shouldHalt', async () => {
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
