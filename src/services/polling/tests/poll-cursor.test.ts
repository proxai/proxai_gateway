import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countByStatus, openInMemoryBufferDb } from 'services/buffer';
import { makeCursorSourcePoller } from 'services/polling/poll-cursor.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-cursor-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

async function seedDb(
  relativePath: string,
  rows: { key: string; value: string }[],
): Promise<string> {
  const path = join(dir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  for (const row of rows) {
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(row.key, row.value);
  }
  db.close();
  return path;
}

test('returns zero result when base dir missing', async () => {
  const poller = makeCursorSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBe(0);
  expect(result.errors).toEqual([]);
});

test('processes only globalStorage db when no workspace dbs exist', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'composerData:abc', value: JSON.stringify({ _v: 13 }) },
    { key: 'bubbleId:def', value: JSON.stringify({ _v: 7 }) },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('processes globalStorage + workspaceStorage dbs', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'composerData:abc', value: JSON.stringify({ _v: 13 }) },
  ]);
  await seedDb('workspaceStorage/aaa111/state.vscdb', [
    { key: 'composerData:xyz', value: JSON.stringify({ _v: 13 }) },
    { key: 'bubbleId:uvw', value: JSON.stringify({ _v: 7 }) },
  ]);
  await seedDb('workspaceStorage/bbb222/state.vscdb', [
    { key: 'bubbleId:lll', value: JSON.stringify({ _v: 7 }) },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBe(3);
  expect(result.capturedBatches).toBe(3);
});

test('skips db files with no allowlisted prefixes (no batch)', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'auth:secret', value: 'secret-stuff' },
    { key: 'somethingelse', value: 'random' },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(0);
});
