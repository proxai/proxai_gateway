import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReadOnly, snapshotSqlite } from 'core/io/sqlite';
import { seedTestDatabase } from 'core/io/sqlite/tests/fixtures.ts';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sqlite-snapshot-'));
  dbPath = join(dir, 'src.sqlite');
  seedTestDatabase(dbPath);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('snapshotSqlite produces a readable copy independent of source', async () => {
  const snap = await snapshotSqlite(dbPath);
  try {
    const db = openReadOnly(snap.path);
    try {
      const rows = db.query<{ name: string }, []>('SELECT name FROM thing ORDER BY id').all();
      expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    } finally {
      db.close();
    }
  } finally {
    await snap.cleanup();
  }
});

test('snapshot paths differ across calls', async () => {
  const a = await snapshotSqlite(dbPath);
  const b = await snapshotSqlite(dbPath);
  expect(a.path).not.toBe(b.path);
  await a.cleanup();
  await b.cleanup();
});

test('snapshot.cleanup is idempotent', async () => {
  const snap = await snapshotSqlite(dbPath);
  await snap.cleanup();
  await snap.cleanup();
});

test('snapshot.cleanup removes the temp file', async () => {
  const snap = await snapshotSqlite(dbPath);
  expect(await Bun.file(snap.path).exists()).toBe(true);
  await snap.cleanup();
  expect(await Bun.file(snap.path).exists()).toBe(false);
});
