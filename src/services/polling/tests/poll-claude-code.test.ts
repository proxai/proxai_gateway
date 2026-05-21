import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countByStatus, openInMemoryBufferDb } from 'services/buffer';
import { makeClaudeCodeSourcePoller } from 'services/polling/poll-claude-code.ts';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-claude-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function seedSession(project: string, name: string, content: string): Promise<string> {
  const projectDir = join(dir, project);
  await mkdir(projectDir, { recursive: true });
  const path = join(projectDir, name);
  await writeFile(path, content);
  return path;
}

test('returns zero result when base dir is missing', async () => {
  const poller = makeClaudeCodeSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
});

test('returns zero result when no project dirs', async () => {
  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
});

test('processes a single session file and inserts a batch', async () => {
  await seedSession(
    'project-a',
    'session.jsonl',
    '{"type":"user","message":{"version":"2.1.122"},"text":"hi"}\n',
  );
  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(1);
  expect(result.capturedBytes).toBeGreaterThan(0);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('processes multiple sessions across multiple projects', async () => {
  await seedSession('project-a', 'session-1.jsonl', '{"type":"user","text":"a"}\n');
  await seedSession('project-a', 'session-2.jsonl', '{"type":"user","text":"b"}\n');
  await seedSession('project-b', 'session-1.jsonl', '{"type":"user","text":"c"}\n');
  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(3);
  expect(result.capturedBatches).toBe(3);
  expect(countByStatus(buffer).pending).toBe(3);
});

test('subsequent poll on same files captures only new bytes', async () => {
  const path = await seedSession('project-a', 'session.jsonl', '{"type":"user","text":"first"}\n');
  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  await poller({ buffer, gatewayVersion: 'gw-0.1', maxDecompressedBytes: 9 * 1024 * 1024 });
  await writeFile(path, '{"type":"user","text":"first"}\n{"type":"user","text":"second"}\n');
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(2);
});

test('captures discover error in result.errors when baseDir is unreadable', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeClaudeCodeSourcePoller({ baseDir: filePath });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]?.sourcePath).toBe(filePath);
});

test('aggregates per-file collect errors into result.errors', async () => {
  await seedSession('p1', 's1.jsonl', '{"type":"user"}\n');
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('minimumMtimeOverride: skips files older than cutoff', async () => {
  const oldPath = await seedSession('proj', 'old.jsonl', '{"type":"user","text":"old"}\n');
  await seedSession('proj', 'fresh.jsonl', '{"type":"user","text":"fresh"}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    minimumMtimeOverride: cutoff,
  });

  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(1);
});

test('default minimumMtime (null): processes all historical files unconditionally', async () => {
  const oldPath = await seedSession('proj', 'old.jsonl', '{"type":"user","text":"old"}\n');
  await seedSession('proj', 'fresh.jsonl', '{"type":"user","text":"fresh"}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const poller = makeClaudeCodeSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBe(2);
});
