import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus, formatBytes } from 'cli/commands/status.ts';
import { captureOutput } from 'cli/output.ts';
import { generateUuidV7, zstdCompressSync } from 'core/utils';
import {
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
} from 'services/buffer';
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
  const bufferFullSentinelPath = join(dir, 'BUFFER_FULL');
  const result = await runStatus({ output: out, buffer, sentinelPath, bufferFullSentinelPath });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('active'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('pending: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('delivered: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('failed: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('pending_bytes:'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('failed_bytes:'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('receipt_count: 0'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('buffer_full: no'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('last_prune_at:'))).toBe(true);
});

test('reports counts of each batch status', async () => {
  const a = batch();
  const b = batch();
  const c = batch();
  insertBatch(buffer, a);
  insertBatch(buffer, b);
  insertBatch(buffer, c);
  markBatchDelivered(buffer, getBatch(buffer, b.captureId)!, { idempotentOnServer: false });
  markBatchFailed(buffer, c.captureId, 'oops');

  const out = captureOutput();
  const result = await runStatus({
    output: out,
    buffer,
    sentinelPath: join(dir, 'PAUSED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('pending: 1'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('delivered: 1'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('failed: 1'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('receipt_count: 1'))).toBe(true);
});

test('reports PAUSED when sentinel exists', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  await pausePolling(sentinelPath, 'manual');
  const out = captureOutput();
  await runStatus({
    output: out,
    buffer,
    sentinelPath,
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
  });
  expect(out.lines.some((l) => l.msg.includes('PAUSED'))).toBe(true);
});

test('reports buffer_full: yes when BUFFER_FULL sentinel exists', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  const bufferFullSentinelPath = join(dir, 'BUFFER_FULL');
  await Bun.write(bufferFullSentinelPath, '{"pending_bytes":1,"threshold":1,"set_at":"x"}');
  const out = captureOutput();
  await runStatus({ output: out, buffer, sentinelPath, bufferFullSentinelPath });
  expect(out.lines.some((l) => l.msg.includes('buffer_full: yes'))).toBe(true);
});

test('reports update_available when UPDATE_AVAILABLE sentinel exists', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  const bufferFullSentinelPath = join(dir, 'BUFFER_FULL');
  const updateAvailableSentinelPath = join(dir, 'UPDATE_AVAILABLE');
  await Bun.write(
    updateAvailableSentinelPath,
    JSON.stringify({
      latest_version: '2026.5.10',
      current_version: '2026.5.7',
      detected_at: '2026-05-06T00:00:00.000Z',
    }),
  );
  const out = captureOutput();
  await runStatus({
    output: out,
    buffer,
    sentinelPath,
    bufferFullSentinelPath,
    updateAvailableSentinelPath,
  });
  expect(out.lines.some((l) => l.msg.includes('update_available: 2026.5.10'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('currently 2026.5.7'))).toBe(true);
});

test('does not print update_available when sentinel absent', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  const bufferFullSentinelPath = join(dir, 'BUFFER_FULL');
  const updateAvailableSentinelPath = join(dir, 'UPDATE_AVAILABLE');
  const out = captureOutput();
  await runStatus({
    output: out,
    buffer,
    sentinelPath,
    bufferFullSentinelPath,
    updateAvailableSentinelPath,
  });
  expect(out.lines.some((l) => l.msg.includes('update_available'))).toBe(false);
});

test('formatBytes handles each magnitude tier', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1024)).toBe('1.00 KB');
  expect(formatBytes(50 * 1024)).toBe('50.0 KB');
  expect(formatBytes(150 * 1024)).toBe('150 KB');
  expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
  expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.00 TB');

  expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024 * 1024)).toContain('TB');
});

test('formatBytes treats invalid input as zero', () => {
  expect(formatBytes(NaN)).toBe('0 B');
  expect(formatBytes(-1)).toBe('0 B');
  expect(formatBytes(Infinity)).toBe('0 B');
});
