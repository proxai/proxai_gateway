import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countByStatus, openInMemoryBufferDb } from 'services/buffer';
import { makeGeminiCliSourcePoller } from 'services/polling/poll-gemini-cli.ts';

let dir: string;
let buffer: Database;

const HEADER = '{"sessionId":"abc","kind":"main"}';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-gemini-cli-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function seedSession(
  project: string,
  name: string,
  content: string,
  sub?: string,
): Promise<string> {
  const chatsDir =
    sub === undefined ? join(dir, project, 'chats') : join(dir, project, 'chats', sub);
  await mkdir(chatsDir, { recursive: true });
  const path = join(chatsDir, name);
  await writeFile(path, content);
  return path;
}

test('returns zero result when base dir is missing', async () => {
  const poller = makeGeminiCliSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
});

test('returns zero result when no project chats dirs', async () => {
  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
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
    'session-2026-01-01-abc.jsonl',
    `${HEADER}\n{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"hi"}]}\n`,
  );
  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
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

test('processes both top-level and nested subagent session files', async () => {
  const evt =
    '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"x"}]}';
  await seedSession('project-a', 'session-2026-01-01-aaa.jsonl', `${HEADER}\n${evt}\n`);
  await seedSession(
    'project-a',
    'subagent.jsonl',
    `${HEADER}\n${evt}\n`,
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBe(2);
  expect(countByStatus(buffer).pending).toBe(2);
});

test('captures discover error in result.errors when baseDir is unreadable', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeGeminiCliSourcePoller({ baseDir: filePath });
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
  const evt =
    '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"x"}]}';
  await seedSession('project-a', 'session.jsonl', `${HEADER}\n${evt}\n`);
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('minimumMtimeOverride: skips files older than cutoff', async () => {
  const evt =
    '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"x"}]}';
  const oldPath = await seedSession('proj', 'old.jsonl', `${HEADER}\n${evt}\n`);
  await seedSession('proj', 'fresh.jsonl', `${HEADER}\n${evt}\n`);
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
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
  const evt =
    '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"x"}]}';
  const oldPath = await seedSession('proj', 'old.jsonl', `${HEADER}\n${evt}\n`);
  await seedSession('proj', 'fresh.jsonl', `${HEADER}\n${evt}\n`);
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const poller = makeGeminiCliSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBe(2);
});

test('non-Error throw from discover is captured as String(err)', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeGeminiCliSourcePoller({ baseDir: filePath });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors[0]?.reason).toBeTruthy();
});
