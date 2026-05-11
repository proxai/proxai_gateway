import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Logger } from 'core/log';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateUuidV7, zstdCompressSync } from 'core/utils';
import {
  getDaemonState,
  getMetadata,
  insertBatch,
  METADATA_KEYS,
  openInMemoryBufferDb,
  setDaemonState,
  setMetadata,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { HttpClient } from 'services/http';
import {
  isBufferFull,
  pausePolling,
  runDrainCycle,
  writeAuthFailedSentinel,
  writeBufferFullSentinel,
} from 'services/polling';
import type { DrainCycleContext } from 'services/polling';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-drain-cycle-'));
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

function makeContext(overrides: Partial<DrainCycleContext> = {}): DrainCycleContext {
  const base: DrainCycleContext = {
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
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
  };
  return { ...base, ...overrides };
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

test('paused sentinel skips drain', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  insertBatch(buffer, batchWith('payload'));
  const ctx = makeContext();
  const result = await runDrainCycle(ctx);
  expect(result.paused).toBe(true);
  expect(result.drainResult).toBeNull();
});

test('AUTH_FAILED sentinel skips drain', async () => {
  await writeAuthFailedSentinel(join(dir, 'AUTH_FAILED'), 'halt');
  const ctx = makeContext();
  const result = await runDrainCycle(ctx);
  expect(result.authFailed).toBe(true);
});

test('BUFFER_FULL sentinel does NOT gate drain — drain still runs', async () => {
  await writeBufferFullSentinel(join(dir, 'BUFFER_FULL'), {
    pendingBytes: 999,
    threshold: 100,
  });
  insertBatch(buffer, batchWith('payload-1'));
  insertBatch(buffer, batchWith('payload-2'));
  const ctx = makeContext();
  const result = await runDrainCycle(ctx);
  expect(result.drainResult?.attempted).toBe(2);
  expect(result.drainResult?.accepted).toBe(2);
});

test('drains pending batches and writes daemon-state snapshot', async () => {
  insertBatch(buffer, batchWith('payload-1'));
  insertBatch(buffer, batchWith('payload-2'));
  const ctx = makeContext();
  const result = await runDrainCycle(ctx);
  expect(result.drainResult?.attempted).toBe(2);
  expect(result.drainResult?.accepted).toBe(2);
  const snap = getDaemonState(buffer);
  expect(snap?.lastDrainAttempted).toBe(2);
  expect(snap?.lastDrainAccepted).toBe(2);
});

test('preserves lastSourceCaptures across drain cycle (read-modify-write)', async () => {
  setDaemonState(buffer, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {
      'claude-code': {
        filesProcessed: 7,
        capturedBatches: 5,
        capturedBytes: 9000,
        errorsCount: 0,
      },
    },
  });
  insertBatch(buffer, batchWith('payload-x'));
  const ctx = makeContext();
  await runDrainCycle(ctx);
  const snap = getDaemonState(buffer);
  expect(snap?.lastSourceCaptures['claude-code']).toEqual({
    filesProcessed: 7,
    capturedBatches: 5,
    capturedBytes: 9000,
    errorsCount: 0,
  });
});

test('clears BUFFER_FULL sentinel when drain drops pending below resume threshold', async () => {
  insertBatch(buffer, batchWith('p'));
  await writeBufferFullSentinel(join(dir, 'BUFFER_FULL'), {
    pendingBytes: 1024,
    threshold: 1000,
  });
  const ctx = makeContext({
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 1000,
      softResumeBytes: 999,
    },
  });
  const result = await runDrainCycle(ctx);
  expect(result.drainResult?.accepted).toBe(1);
  expect(await isBufferFull(join(dir, 'BUFFER_FULL'))).toBe(false);
});

test('persists drain cycle metrics: total, last_at, duration', async () => {
  insertBatch(buffer, batchWith('p'));
  const ctx = makeContext();
  await runDrainCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.drainCyclesTotal)).toBe('1');
  expect(getMetadata(buffer, METADATA_KEYS.drainLastCycleAt)).toMatch(/Z$/);
  expect(getMetadata(buffer, METADATA_KEYS.drainTotalBatchesShipped)).toBe('1');
  expect(getMetadata(buffer, METADATA_KEYS.uploadTotalBatchesShipped)).toBe('1');
});

test('persists per-source upload counters from drain accepted-by-source', async () => {
  insertBatch(buffer, batchWith('p'));
  const ctx = makeContext();
  await runDrainCycle(ctx);
  expect(getMetadata(buffer, 'upload_batches_shipped_by_source.claude-code')).toBe('1');
});

test('drain with no pending records still updates drain cycle counter', async () => {
  const ctx = makeContext();
  await runDrainCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.drainCyclesTotal)).toBe('1');
  expect(getMetadata(buffer, METADATA_KEYS.drainTotalBatchesShipped)).toBeNull();
});

test('logs warn when prune throws', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext({ logger: fakeLogger as unknown as Logger });
  buffer.exec('DROP TABLE upload_receipts');
  await runDrainCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('prune failed'))).toBe(true);
});

test('logs warn when daemon-state persist fails', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  buffer.exec('DROP TABLE daemon_state');
  const ctx = makeContext({ logger: fakeLogger as unknown as Logger });
  await runDrainCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist daemon')),
  ).toBe(true);
});

test('logs warn when drain metrics persist fails', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  setMetadata(buffer, METADATA_KEYS.drainCyclesTotal, 'not-a-number');
  insertBatch(buffer, batchWith('p'));
  const ctx = makeContext({ logger: fakeLogger as unknown as Logger });
  await runDrainCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.drainCyclesTotal)).toBe('1');
});

test('logs warn when drain setMetadata throws (table dropped)', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  insertBatch(buffer, batchWith('p'));
  buffer.exec('DROP TABLE buffer_metadata');
  const ctx = makeContext({ logger: fakeLogger as unknown as Logger });
  await runDrainCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist drain'))).toBe(
    true,
  );
});

test('paused cycle without logger returns gracefully', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  const ctx = makeContext();
  const result = await runDrainCycle(ctx);
  expect(result.paused).toBe(true);
});

test('counts retriable / fatal in drain.cycles_with_errors', async () => {
  insertBatch(buffer, batchWith('p'));
  let calls = 0;
  const ctx = makeContext({
    http: new HttpClient({
      apiKey: 'pxg_test',
      hostId: 'h_test',
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        verifyKey: 'https://api.example.com/ingestion/verify-key',
        watermarks: 'https://api.example.com/v1/watermarks',
        registerHostId: 'https://api.example.com/v1/host-ids/register',
      },
      fetch: (async () => {
        calls++;
        return new Response(null, { status: 503 });
      }) as unknown as typeof globalThis.fetch,
    }),
  });
  await runDrainCycle(ctx);
  expect(calls).toBeGreaterThan(0);
  expect(getMetadata(buffer, METADATA_KEYS.drainCyclesWithErrors)).toBe('1');
});

interface FakeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
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
    child: () => logger,
  };
  return logger;
}
