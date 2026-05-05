import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus } from 'cli/command-status.ts';
import { captureOutput } from 'cli/output.ts';
import { generateUuidV7, zstdCompressSync } from 'core/utils';
import { insertBatch, markBatchDone, markBatchFailed, openInMemoryBufferDb } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { pausePolling } from 'services/polling';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-status-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

function batch(text = 'x'): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/x',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: text.length,
    watermarkTable: null,
    agentSchemaVersion: '1.0',
    gatewayVersion: 'gw',
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
  };
}

test('reports active status with zero counts on empty buffer', async () => {
  const out = captureOutput();
  const sentinelPath = join(dir, 'PAUSED');
  const result = await runStatus({ output: out, buffer, sentinelPath });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('active'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('pending: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('done: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('failed: 0'))).toBe(true);
});

test('reports counts of each batch status', async () => {
  const a = batch();
  const b = batch();
  const c = batch();
  insertBatch(buffer, a);
  insertBatch(buffer, b);
  insertBatch(buffer, c);
  markBatchDone(buffer, b.captureId);
  markBatchFailed(buffer, c.captureId, 'oops');

  const out = captureOutput();
  const result = await runStatus({
    output: out,
    buffer,
    sentinelPath: join(dir, 'PAUSED'),
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('pending: 1'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('done: 1'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('failed: 1'))).toBe(true);
});

test('reports PAUSED when sentinel exists', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  await pausePolling(sentinelPath, 'manual');
  const out = captureOutput();
  await runStatus({ output: out, buffer, sentinelPath });
  expect(out.lines.some((l) => l.msg.includes('PAUSED'))).toBe(true);
});
