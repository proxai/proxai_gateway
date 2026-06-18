import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireDefined } from 'core/utils';
import { markBatchDelivered, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-codex-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function seedRollout(relativePath: string, content: string): Promise<string> {
  const path = join(dir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function seedStateDb(
  relativePath: string,
  threads: { id: string; cli_version: string | null }[],
  dynamicTools: { thread_id: string; position: number; name: string }[] = [],
): Promise<string> {
  const path = join(dir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE threads (id TEXT PRIMARY KEY, cli_version TEXT)');
  db.run(
    'CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, name TEXT, PRIMARY KEY (thread_id, position))',
  );
  db.run(
    'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)',
  );
  for (const t of threads) {
    db.query('INSERT INTO threads (id, cli_version) VALUES (?, ?)').run(t.id, t.cli_version);
  }
  for (const tool of dynamicTools) {
    db.query('INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES (?, ?, ?)').run(
      tool.thread_id,
      tool.position,
      tool.name,
    );
  }
  db.close();
  return path;
}

test('returns zero result when base dir missing', async () => {
  const poller = makeCodexSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
});

test('rollouts use default version when no state file exists', async () => {
  await seedRollout(
    'sessions/2026/05/05/rollout-001.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.capturedBatches).toBe(1);
  const row = requireDefined(nextPendingBatch(buffer));
  expect(row.agentSchemaVersion).toBe('unknown');
});

test('pollCodex does not capture Codex state — only the rollout produces batches', async () => {
  await seedStateDb('state_1.sqlite', [{ id: 'tA', cli_version: 'codex-1.0.0' }]);
  await seedRollout(
    'sessions/2026/05/05/rollout-001.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  // State sqlite is no longer captured; only the rollout becomes a batch.
  expect(result.capturedBatches).toBe(1);
  const row = requireDefined(nextPendingBatch(buffer));
  expect(row.sourceKind).toBe('jsonl_append'); // rollout, not the sqlite_table_snapshot state
});

test('captures discover errors when baseDir is a regular file', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeCodexSourcePoller({ baseDir: filePath });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('captures discover error when baseDir is invalid', async () => {
  const baseDir = `${join(dir, 'invalid')}${String.fromCharCode(0)}subdir`;
  const poller = makeCodexSourcePoller({ baseDir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('copies per-rollout collect errors into pollCodex result.errors', async () => {
  await seedRollout(
    'sessions/2026/05/05/rollout-001.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('captures per-rollout collect errors in result.errors', async () => {
  await seedRollout(
    'sessions/2026/05/05/rollout-001.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const rolloutPath = join(dir, 'sessions/2026/05/05/rollout-001.jsonl');
  await rm(rolloutPath, { force: true });
  await mkdir(rolloutPath, { recursive: true });
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBeGreaterThanOrEqual(0);
});

test('minimumMtimeOverride applies a floor on a fresh buffer', async () => {
  const oldPath = await seedRollout(
    'sessions/2020/01/01/rollout-old.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const newPath = await seedRollout(
    'sessions/2026/05/05/rollout-new.jsonl',
    '{"type":"session_meta","payload":{}}\n',
  );
  const { utimes } = await import('node:fs/promises');
  const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
  await utimes(oldPath, oldDate, oldDate);
  await utimes(newPath, new Date(), new Date());
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    minimumMtimeOverride: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);
  const seenPaths = new Set<string>();
  let row = nextPendingBatch(buffer);
  while (row !== null) {
    seenPaths.add(row.sourcePath);
    markBatchDelivered(buffer, row, { idempotentOnServer: false });
    row = nextPendingBatch(buffer);
  }
  expect(seenPaths.has(oldPath)).toBe(false);
  expect(seenPaths.has(newPath)).toBe(true);
});
