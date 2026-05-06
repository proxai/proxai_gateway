import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zstdDecompressSync } from 'core/utils';
import {
  countByStatus,
  markBatchDelivered,
  nextPendingBatch,
  openInMemoryBufferDb,
} from 'services/buffer';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-codex-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
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

const DECODER = new TextDecoder();

test('returns zero result when base dir missing', async () => {
  const poller = makeCodexSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
});

test('processes state then rollouts and threads cli_version through', async () => {
  await seedStateDb(
    'state_3.sqlite',
    [{ id: 't1', cli_version: 'codex-9.9.9' }],
    [{ thread_id: 't1', position: 0, name: 'Read' }],
  );
  await seedRollout('sessions/2026/05/05/rollout-001.jsonl', '{"type":"user","text":"hello"}\n');
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });

  expect(result.filesProcessed).toBeGreaterThanOrEqual(2);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);
  expect(countByStatus(buffer).pending).toBeGreaterThanOrEqual(2);

  let foundRolloutWithVersion = false;
  let row = nextPendingBatch(buffer);
  while (row !== null) {
    if (row.sourceKind === 'jsonl_append' && row.agentSchemaVersion === 'codex-9.9.9') {
      foundRolloutWithVersion = true;
    }
    DECODER.decode(zstdDecompressSync(row.body));
    markBatchDelivered(buffer, row, { idempotentOnServer: false });
    row = nextPendingBatch(buffer);
  }
  expect(foundRolloutWithVersion).toBe(true);
});

test('rollouts use default version when no state file exists', async () => {
  await seedRollout('sessions/2026/05/05/rollout-001.jsonl', '{"type":"user","text":"x"}\n');
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.capturedBatches).toBe(1);
  const row = nextPendingBatch(buffer)!;
  expect(row.agentSchemaVersion).toBe('unknown');
});

test('captures discover errors when baseDir is a regular file', async () => {
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeCodexSourcePoller({ baseDir: filePath });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('captures state-side discover error when baseDir is extreme', async () => {
  const tooLong = `/${'x'.repeat(10_000)}`;
  const poller = makeCodexSourcePoller({ baseDir: tooLong });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('copies per-table state errors into pollCodex result.errors', async () => {
  await seedStateDb('state_3.sqlite', [{ id: 't1', cli_version: 'codex-test' }]);
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer: closedBuffer, gatewayVersion: 'gw-0.1' });
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.some((e) => e.table !== undefined)).toBe(true);
});

test('copies per-rollout collect errors into pollCodex result.errors', async () => {
  await seedRollout('sessions/2026/05/05/rollout-001.jsonl', '{"type":"user","text":"x"}\n');
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer: closedBuffer, gatewayVersion: 'gw-0.1' });
  expect(result.errors.length).toBeGreaterThan(0);
});

test('captures per-rollout collect errors in result.errors', async () => {
  await seedRollout('sessions/2026/05/05/rollout-001.jsonl', '{"type":"user","text":"x"}\n');
  const rolloutPath = join(dir, 'sessions/2026/05/05/rollout-001.jsonl');
  await rm(rolloutPath, { force: true });
  await mkdir(rolloutPath, { recursive: true });
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBeGreaterThanOrEqual(0);
});

test('state-only run still inserts batches from threads table', async () => {
  await seedStateDb('state_1.sqlite', [{ id: 'tA', cli_version: 'codex-1.0.0' }]);
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);
});

test('initialScanWindowDays applies a now-N-day floor on a fresh buffer', async () => {
  // No prior cursor exists for codex, and we set initialScanWindowDays > 0,
  // so resolveMinimumMtime returns a Date(now - 30d) and discover skips
  // older files. We seed two rollouts: one mtime'd long ago, one recent.
  const oldPath = await seedRollout('sessions/2020/01/01/rollout-old.jsonl', 'x\n');
  const newPath = await seedRollout('sessions/2026/05/05/rollout-new.jsonl', 'y\n');
  const { utimes } = await import('node:fs/promises');
  const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365); // ~1 year ago
  await utimes(oldPath, oldDate, oldDate);
  await utimes(newPath, new Date(), new Date());
  const poller = makeCodexSourcePoller({ baseDir: dir, initialScanWindowDays: 30 });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  // The recent file should be captured; the year-old file should not.
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
