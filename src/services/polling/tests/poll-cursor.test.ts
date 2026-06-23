import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
  await rmRecursive(dir);
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
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.errors).toEqual([]);
});

test('processes only globalStorage db when no workspace dbs exist', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'composerData:abc', value: JSON.stringify({ _v: 13 }) },
    { key: 'bubbleId:def', value: JSON.stringify({ _v: 7 }) },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
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
    { key: 'bubbleId:uvw', value: JSON.stringify({ _v: 7, text: 'hi' }) },
  ]);
  await seedDb('workspaceStorage/bbb222/state.vscdb', [
    { key: 'bubbleId:lll', value: JSON.stringify({ _v: 7, text: 'hello' }) },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(3);
  expect(result.capturedBatches).toBe(3);
});

test('skips db files with no allowlisted prefixes (no batch)', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'auth:secret', value: 'secret-stuff' },
    { key: 'somethingelse', value: 'random' },
  ]);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(0);
});

test('captures discover error in result.errors when baseDir is unreadable', async () => {
  const { writeFile } = await import('node:fs/promises');
  const filePath = join(dir, 'is-a-file');
  await writeFile(filePath, 'not a directory');
  const poller = makeCursorSourcePoller({ baseDir: filePath });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('aggregates per-file collect errors into result.errors', async () => {
  await seedDb('globalStorage/state.vscdb', [
    { key: 'composerData:abc', value: JSON.stringify({ _v: 13 }) },
  ]);
  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('forwards excludedProjects so an excluded workspace folder pauses capture (no batch)', async () => {
  // Per-workspace DB maps 1:1 to its sibling workspace.json folder. An excluded prefix → pause.
  // Without the poller forwarding ctx.excludedProjects, this workspace would capture a batch.
  const wsDbPath = await seedDb('workspaceStorage/secretws/state.vscdb', [
    { key: 'composerData:secret', value: JSON.stringify({ _v: 13 }) },
  ]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(wsDbPath, '..', 'workspace.json'),
    JSON.stringify({ folder: 'file:///Users/me/secret' }),
  );
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    excludedProjects: ['/Users/me/secret'],
  });
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('minimumMtimeOverride applies a floor on a fresh buffer', async () => {
  const oldPath = await seedDb('workspaceStorage/old/state.vscdb', [
    { key: 'composerData:abc', value: JSON.stringify({ _v: 13 }) },
  ]);
  await seedDb('globalStorage/state.vscdb', [
    { key: 'composerData:xyz', value: JSON.stringify({ _v: 13 }) },
  ]);
  const { utimes } = await import('node:fs/promises');
  const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
  await utimes(oldPath, oldDate, oldDate);
  const poller = makeCursorSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    minimumMtimeOverride: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  expect(result.filesProcessed).toBe(1);
});
