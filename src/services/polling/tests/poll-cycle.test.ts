import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateUuidV7, zstdCompressSync } from 'core/utils';
import { insertBatch, openInMemoryBufferDb } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { HttpClient } from 'services/http';
import { pausePolling, runPollCycle } from 'services/polling';
import type { PollCycleContext, RegisteredSource } from 'services/polling';

let dir: string;
let buffer: Database;

const noopAsync = async (): Promise<void> => {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-cycle-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function fakeFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ capture_id: 'irrelevant', accepted: true, idempotent: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

function makeContext(sources: RegisteredSource[]): PollCycleContext {
  return {
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
    gatewayVersion: 'gw-0.1',
    sources,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    installedAt: new Date().toISOString(),
    staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
    capturePolicy: { initialScanWindowDays: 30, maxDecompressedBytes: 9 * 1024 * 1024 },
  };
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

function batchWith(text: string): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/tmp/x.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: text.length,
    watermarkTable: null,
    agentSchemaVersion: '1.0',
    gatewayVersion: 'gw-0.1',
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
  };
}

test('paused sentinel short-circuits the cycle', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  const ctx = makeContext([noopSource('s1')]);
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(true);
  expect(result.sourceResults).toEqual({});
  expect(result.drainResult).toBeNull();
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

test('runs all registered sources when not paused', async () => {
  let calledA = 0;
  let calledB = 0;
  const ctx = makeContext([
    {
      name: 's-a',
      poll: async () => {
        calledA++;
        return { filesProcessed: 1, capturedBatches: 1, capturedBytes: 100, errors: [] };
      },
    },
    {
      name: 's-b',
      poll: async () => {
        calledB++;
        return { filesProcessed: 2, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(false);
  expect(calledA).toBe(1);
  expect(calledB).toBe(1);
  expect(result.sourceResults['s-a']?.filesProcessed).toBe(1);
  expect(result.sourceResults['s-b']?.filesProcessed).toBe(2);
});

test('drains pending batches after sources run', async () => {
  insertBatch(buffer, batchWith('payload-1'));
  insertBatch(buffer, batchWith('payload-2'));
  const ctx = makeContext([noopSource('noop')]);
  const result = await runPollCycle(ctx);
  expect(result.drainResult).not.toBeNull();
  expect(result.drainResult?.attempted).toBe(2);
  expect(result.drainResult?.accepted).toBe(2);
});

test('startedAt and completedAt are valid ISO UTC strings', async () => {
  const ctx = makeContext([noopSource('s')]);
  const result = await runPollCycle(ctx);
  expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('aggregates errors from multiple sources into sourceResults', async () => {
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => ({
        filesProcessed: 1,
        capturedBatches: 0,
        capturedBytes: 0,
        errors: [{ sourcePath: '/x', reason: 'boom' }],
      }),
    },
  ]);
  const result = await runPollCycle(ctx);
  expect(result.sourceResults['s']?.errors).toEqual([{ sourcePath: '/x', reason: 'boom' }]);
});

test('stale binary past pause threshold writes sentinel and short-circuits via pause check', async () => {
  let calls = 0;
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => {
        calls++;
        return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  const DAY_MS = 86_400_000;
  ctx.installedAt = new Date(Date.now() - 200 * DAY_MS).toISOString();
  ctx.staleBinary = { warnAfterDays: 30, pauseAfterDays: 60 };
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(true);
  expect(calls).toBe(0);
  expect(await Bun.file(join(dir, 'PAUSED')).exists()).toBe(true);
});

test('stale binary in warning window does not pause; sources still run', async () => {
  let calls = 0;
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => {
        calls++;
        return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  const DAY_MS = 86_400_000;
  ctx.installedAt = new Date(Date.now() - 40 * DAY_MS).toISOString();
  ctx.staleBinary = { warnAfterDays: 30, pauseAfterDays: 60 };
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(false);
  expect(calls).toBe(1);
  expect(await Bun.file(join(dir, 'PAUSED')).exists()).toBe(false);
});

test('AUTH_FAILED sentinel short-circuits the cycle before sources/drain', async () => {
  let calls = 0;
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => {
        calls++;
        return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  await Bun.write(ctx.authFailedSentinelPath, '{"reason":"halt","detected_at":"x"}');
  const result = await runPollCycle(ctx);
  expect(result.authFailed).toBe(true);
  expect(result.paused).toBe(false);
  expect(calls).toBe(0);
  expect(result.drainResult).toBeNull();
});

test('BUFFER_FULL sentinel short-circuits the cycle when pending still above resume threshold', async () => {
  let calls = 0;
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => {
        calls++;
        return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  ctx.bufferPolicy = {
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    softPauseBytes: 100,
    softResumeBytes: 50,
  };

  insertBatch(
    buffer,
    batchWith('payload-large-enough-to-exceed-fifty-bytes-and-then-some-more-padding'),
  );
  await Bun.write(ctx.bufferFullSentinelPath, '{"pending_bytes":1,"threshold":1,"set_at":"x"}');
  const result = await runPollCycle(ctx);
  expect(result.bufferFull).toBe(true);
  expect(result.paused).toBe(false);
  expect(result.authFailed).toBe(false);
  expect(calls).toBe(0);
  expect(result.drainResult).toBeNull();
  expect(result.pruneResult).toBeNull();
  expect(result.pressureResult).not.toBeNull();
  expect(await Bun.file(ctx.bufferFullSentinelPath).exists()).toBe(true);
});

test('cycle calls prune after drain and records prune result', async () => {
  const ctx = makeContext([noopSource('s')]);
  const result = await runPollCycle(ctx);
  expect(result.pruneResult).not.toBeNull();
  expect(result.pruneResult?.receiptsDeleted).toBe(0);
  expect(result.pruneResult?.failedBatchesDeleted).toBe(0);
});

test('cycle writes BUFFER_FULL sentinel when pending exceeds pause threshold', async () => {
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    http: new HttpClient({
      apiKey: 'pxg_test',
      hostId: 'h_test',
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        verifyKey: 'https://api.example.com/ingestion/verify-key',
        watermarks: 'https://api.example.com/v1/watermarks',
        registerHostId: 'https://api.example.com/v1/host-ids/register',
      },
      fetch: (async () => new Response('', { status: 503 })) as unknown as typeof globalThis.fetch,
    }),
  };
  ctx.bufferPolicy = {
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    softPauseBytes: 10,
    softResumeBytes: 5,
  };
  insertBatch(buffer, batchWith('this-is-much-larger-than-ten-bytes-padding-payload-foobarbaz'));
  const result = await runPollCycle(ctx);
  expect(result.bufferFull).toBe(false);
  expect(result.pressureResult?.shouldPause).toBe(true);
  expect(await Bun.file(ctx.bufferFullSentinelPath).exists()).toBe(true);
});

test('cycle clears BUFFER_FULL sentinel when pending drops below resume threshold', async () => {
  const ctx = makeContext([noopSource('s')]);
  ctx.bufferPolicy = {
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    softPauseBytes: 1_000_000,
    softResumeBytes: 500_000,
  };

  await Bun.write(
    ctx.bufferFullSentinelPath,
    '{"pending_bytes":1500000,"threshold":1000000,"set_at":"x"}',
  );
  expect(await Bun.file(ctx.bufferFullSentinelPath).exists()).toBe(true);

  const result = await runPollCycle(ctx);
  expect(result.bufferFull).toBe(false);
  expect(result.drainResult).not.toBeNull();
  expect(await Bun.file(ctx.bufferFullSentinelPath).exists()).toBe(false);
});

interface FakeLogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function makeFakeLogger(entries: FakeLogEntry[]): NonNullable<PollCycleContext['logger']> {
  const logger = {
    child: () => logger,
    fatal: () => undefined,
    error: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'error', obj, msg });
    },
    warn: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'warn', obj, msg });
    },
    info: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'info', obj, msg });
    },
    debug: () => undefined,
    trace: () => undefined,
  };
  return logger as unknown as NonNullable<PollCycleContext['logger']>;
}

test('cycle logs soft_resume info at cycle-start when sentinel exists and pending is below resume', async () => {
  const entries: FakeLogEntry[] = [];
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    logger: makeFakeLogger(entries),
  };
  ctx.bufferPolicy = {
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    softPauseBytes: 1_000_000,
    softResumeBytes: 500_000,
  };
  await Bun.write(
    ctx.bufferFullSentinelPath,
    '{"pending_bytes":1500000,"threshold":1000000,"set_at":"x"}',
  );
  await runPollCycle(ctx);

  expect(
    entries.some(
      (e) =>
        e.level === 'info' &&
        e.msg.includes('buffer pending pressure dropped') &&
        e.msg.includes('cycle start'),
    ),
  ).toBe(true);
});

test('cycle logs post-drain soft_resume when a source writes the sentinel mid-cycle', async () => {
  const entries: FakeLogEntry[] = [];

  let sentinelWriter: () => Promise<void> = noopAsync;
  const writerSource: RegisteredSource = {
    name: 'writer',
    poll: async () => {
      await sentinelWriter();
      return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
    },
  };
  const ctx: PollCycleContext = {
    ...makeContext([writerSource]),
    logger: makeFakeLogger(entries),
  };
  ctx.bufferPolicy = {
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    softPauseBytes: 1_000_000,
    softResumeBytes: 500_000,
  };

  sentinelWriter = async () => {
    await Bun.write(
      ctx.bufferFullSentinelPath,
      '{"pending_bytes":1500000,"threshold":1000000,"set_at":"mid-cycle"}',
    );
  };
  await runPollCycle(ctx);
  expect(
    entries.some(
      (e) =>
        e.level === 'info' &&
        e.msg.includes('buffer pending pressure dropped') &&
        !e.msg.includes('cycle start'),
    ),
  ).toBe(true);
});

function makeQueryThrowingBuffer(
  realBuffer: Database,
  shouldThrowOn: (sql: string) => boolean,
): Database {
  const fake: Record<string, unknown> = {};
  for (const key of Object.keys(realBuffer)) {
    fake[key] = (realBuffer as unknown as Record<string, unknown>)[key];
  }
  for (const key of [
    'query',
    'run',
    'prepare',
    'transaction',
    'exec',
    'close',
    'serialize',
  ] as const) {
    const original = (realBuffer as unknown as Record<string, unknown>)[key];
    if (typeof original === 'function') {
      fake[key] = (...args: unknown[]) => {
        if (key === 'query' && typeof args[0] === 'string' && shouldThrowOn(args[0])) {
          throw new Error('synthetic query failure');
        }
        return (original as Function).apply(realBuffer, args);
      };
    }
  }
  return fake as unknown as Database;
}

test('cycle logs prune_failed warn when pruneBuffer throws', async () => {
  const entries: FakeLogEntry[] = [];

  const fake: Record<string, unknown> = {};
  for (const key of ['query', 'run', 'prepare', 'exec', 'close', 'serialize'] as const) {
    const original = (buffer as unknown as Record<string, unknown>)[key];
    if (typeof original === 'function') {
      fake[key] = (...args: unknown[]) => (original as Function).apply(buffer, args);
    }
  }
  let txCalls = 0;
  fake['transaction'] = (fn: () => unknown) => {
    txCalls++;
    return () => {
      if (txCalls === 1) throw new Error('synthetic prune transaction failure');
      return fn();
    };
  };
  const wrapped = fake as unknown as Database;

  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    buffer: wrapped,
    logger: makeFakeLogger(entries),
  };
  await runPollCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('buffer prune failed'))).toBe(
    true,
  );
});

function makeVersionFetch(tagName: string): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: tagName,
          assets: [
            { name: 'proxai-gateway-linux-x64', browser_download_url: 'https://example.com/asset' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

test('version check writes UPDATE_AVAILABLE sentinel when newer release exists', async () => {
  const sentinelPath = join(dir, 'UPDATE_AVAILABLE');
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    gatewayVersion: '2026.5.7',
    updateAvailableSentinelPath: sentinelPath,
    versionCheckFetch: makeVersionFetch('v2026.5.10'),
  };
  await runPollCycle(ctx);
  expect(await Bun.file(sentinelPath).exists()).toBe(true);
});

test('version check does not write sentinel when up to date', async () => {
  const sentinelPath = join(dir, 'UPDATE_AVAILABLE');
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    gatewayVersion: '2026.5.7',
    updateAvailableSentinelPath: sentinelPath,
    versionCheckFetch: makeVersionFetch('v2026.5.7'),
  };
  await runPollCycle(ctx);
  expect(await Bun.file(sentinelPath).exists()).toBe(false);
});

test('version check fires once per interval and skips on subsequent cycles within window', async () => {
  const sentinelPath = join(dir, 'UPDATE_AVAILABLE');
  let calls = 0;
  const trackingFetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      calls++;
      return new Response(
        JSON.stringify({
          tag_name: 'v2026.5.10',
          assets: [
            { name: 'proxai-gateway-linux-x64', browser_download_url: 'https://example.com/asset' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;

  const baseCtx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    gatewayVersion: '2026.5.7',
    updateAvailableSentinelPath: sentinelPath,
    versionCheckFetch: trackingFetch,
    versionCheckIntervalMs: 4 * 60 * 60 * 1000,
  };

  await runPollCycle(baseCtx);
  await runPollCycle(baseCtx);
  await runPollCycle(baseCtx);
  expect(calls).toBe(1);
});

test('version check failure logs warn and continues the cycle', async () => {
  const sentinelPath = join(dir, 'UPDATE_AVAILABLE_DIR');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(sentinelPath, { recursive: true });
  const entries: FakeLogEntry[] = [];
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    gatewayVersion: '2026.5.7',
    updateAvailableSentinelPath: sentinelPath,
    versionCheckFetch: makeVersionFetch('v2026.5.7'),
    logger: makeFakeLogger(entries),
  };
  await runPollCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('version check failed'))).toBe(
    true,
  );
});

test('version check returning null is logged as unavailable and clears no sentinel', async () => {
  const sentinelPath = join(dir, 'UPDATE_AVAILABLE');
  const entries: FakeLogEntry[] = [];
  const fetchFn: typeof globalThis.fetch = (async () =>
    new Response('upstream error', { status: 503 })) as unknown as typeof globalThis.fetch;
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    gatewayVersion: '2026.5.7',
    updateAvailableSentinelPath: sentinelPath,
    versionCheckFetch: fetchFn,
    logger: makeFakeLogger(entries),
  };
  await runPollCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('version check returned no result')),
  ).toBe(true);
  expect(await Bun.file(sentinelPath).exists()).toBe(false);
});

test('cycle logs pressure_failed warn when pressure check throws', async () => {
  const entries: FakeLogEntry[] = [];
  const wrapped = makeQueryThrowingBuffer(buffer, (sql) => sql.includes('SUM(LENGTH(body))'));
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    buffer: wrapped,
    logger: makeFakeLogger(entries),
  };
  await runPollCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('buffer pressure check failed')),
  ).toBe(true);
});

test('cycle logs daemon_state.persist_failed warn when setDaemonState throws', async () => {
  const entries: FakeLogEntry[] = [];
  const wrapped = makeQueryThrowingBuffer(buffer, (sql) => sql.includes('daemon_state'));
  const ctx: PollCycleContext = {
    ...makeContext([noopSource('s')]),
    buffer: wrapped,
    logger: makeFakeLogger(entries),
  };
  await runPollCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist daemon state')),
  ).toBe(true);
});
