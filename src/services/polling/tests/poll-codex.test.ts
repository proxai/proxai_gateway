import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zstdDecompressSync } from 'core/utils';
import { countByStatus, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
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
    buffer.run(`UPDATE upload_batches SET status='done' WHERE capture_id='${row.captureId}'`);
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

test('state-only run still inserts batches from threads table', async () => {
  await seedStateDb('state_1.sqlite', [{ id: 'tA', cli_version: 'codex-1.0.0' }]);
  const poller = makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);
});
