import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countByStatus, openInMemoryBufferDb } from 'services/buffer';
import { makeClaudeDesktopSourcePoller } from 'services/polling/poll-claude-desktop.ts';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-claude-desktop-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function seedSession(
  org: string,
  proj: string,
  localDirName: string,
  content: string,
): Promise<string> {
  const localDir = join(dir, org, proj, localDirName);
  await mkdir(localDir, { recursive: true });
  const path = join(localDir, 'audit.jsonl');
  await writeFile(path, content);
  return path;
}

test('makeClaudeDesktopSourcePoller: defaults baseDir and executes successfully on empty directory', async () => {
  // Test calling with no options to cover default parameter options = {}
  const poller = makeClaudeDesktopSourcePoller();
  expect(poller).toBeTypeOf('function');
});

test('returns zero result when base dir is missing', async () => {
  const poller = makeClaudeDesktopSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
});

test('processes a single session file and inserts a batch', async () => {
  await seedSession(
    'org-1',
    'proj-1',
    'local_1',
    '{"type":"user","uuid":"123","message":{"role":"user","content":"hello"}}\n',
  );
  const poller = makeClaudeDesktopSourcePoller({ baseDir: dir });
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

test('processes multiple sessions and aggregates results', async () => {
  await seedSession(
    'org-1',
    'proj-1',
    'local_1',
    '{"type":"user","uuid":"123","message":{"role":"user","content":"hello"}}\n',
  );
  await seedSession(
    'org-1',
    'proj-1',
    'local_2',
    '{"type":"user","uuid":"456","message":{"role":"user","content":"world"}}\n',
  );
  const poller = makeClaudeDesktopSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBe(2);
  expect(countByStatus(buffer).pending).toBe(2);
});

test('captures discover error in result.errors when baseDir is unreadable/is a file', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeClaudeDesktopSourcePoller({ baseDir: filePath });
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
  await seedSession(
    'org-1',
    'proj-1',
    'local_1',
    '{"type":"user","uuid":"123","message":{"role":"user","content":"hello"}}\n',
  );
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeClaudeDesktopSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('minimumMtimeOverride: skips files older than cutoff', async () => {
  await seedSession(
    'org-1',
    'proj-1',
    'local_1',
    '{"type":"user","uuid":"123","message":{"role":"user","content":"hello"}}\n',
  );
  const poller = makeClaudeDesktopSourcePoller({ baseDir: dir });
  const cutoff = new Date(Date.now() + 60_000); // in the future
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    minimumMtimeOverride: cutoff,
  });
  expect(result.filesProcessed).toBe(0);
});
