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
import type { Logger } from 'core/log';
import { pausePolling, runPollCycle } from 'services/polling';
import type { PollCycleContext, RegisteredSource } from 'services/polling';
import type { Pacer } from 'services/uploader';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-cycle-compat-'));
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
    capturePolicy: { maxDecompressedBytes: 9 * 1024 * 1024 },
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

test('compat: paused sentinel short-circuits the cycle and skips drain', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  const ctx = makeContext([noopSource('s1')]);
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(true);
  expect(result.sourceResults).toEqual({});
  expect(result.drainResult).toBeNull();
});

test('compat: runs sources then drains pending batches', async () => {
  insertBatch(buffer, batchWith('payload-1'));
  insertBatch(buffer, batchWith('payload-2'));
  let calledA = 0;
  const ctx = makeContext([
    {
      name: 's-a',
      poll: async () => {
        calledA++;
        return { filesProcessed: 1, capturedBatches: 1, capturedBytes: 100, errors: [] };
      },
    },
  ]);
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(false);
  expect(calledA).toBe(1);
  expect(result.sourceResults['s-a']?.filesProcessed).toBe(1);
  expect(result.drainResult).not.toBeNull();
  expect(result.drainResult?.attempted).toBe(2);
  expect(result.drainResult?.accepted).toBe(2);
});

test('compat: AUTH_FAILED sentinel short-circuits before sources/drain', async () => {
  await Bun.write(join(dir, 'AUTH_FAILED'), '{"reason":"halt","detected_at":"x"}');
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
  const result = await runPollCycle(ctx);
  expect(result.authFailed).toBe(true);
  expect(calls).toBe(0);
  expect(result.drainResult).toBeNull();
});

test('compat: startedAt and completedAt are valid ISO UTC strings', async () => {
  const ctx = makeContext([noopSource('s')]);
  const result = await runPollCycle(ctx);
  expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('compat: aggregates per-source results', async () => {
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

test('compat: covers optional cycle params', async () => {
  const ctx = makeContext([noopSource('s')]);
  // Why: the smoke test only verifies optional fields pass through without
  // crashing — neither the logger nor the pacer is exercised. The single
  // `as unknown as` hop bridges narrow no-op stubs to the wider pino/Pacer
  // surface area without dragging in real implementations.
  const mockLogger: unknown = {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    // pino-style child loggers usually return a new pre-bound logger; the
    // smoke test just needs the call to be a no-op-friendly self-reference.
    child(this: unknown) {
      return this;
    },
  };
  const typedLogger = mockLogger as Logger;
  const mockPacer = {
    acquire: async () => {},
    notifyRetryAfter: () => {},
    notify429: () => {},
    notifyServiceUnavailable: () => {},
  } satisfies Pacer;
  ctx.logger = typedLogger;
  ctx.minimumMtimeOverride = new Date('2026-05-08T00:00:00Z');
  ctx.pacer = mockPacer;
  const result = await runPollCycle(ctx);
  expect(result.paused).toBe(false);
});
