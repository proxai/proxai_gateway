import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-cycle-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
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
      },
      fetch: fakeFetch(),
    }),
    hostId: 'h_test',
    gatewayVersion: 'gw-0.1',
    sources,
    pauseSentinelPath: join(dir, 'PAUSED'),
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
