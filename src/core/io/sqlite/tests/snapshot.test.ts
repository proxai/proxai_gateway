import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReadOnly, snapshotSqlite } from 'core/io/sqlite';
import type { SnapshotOpenImpl } from 'core/io/sqlite/snapshot.ts';
import { seedTestDatabase } from 'core/io/sqlite/tests/fixtures.ts';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sqlite-snapshot-'));
  dbPath = join(dir, 'src.sqlite');
  seedTestDatabase(dbPath);
});

afterAll(async () => {
  await rmRecursive(dir);
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

test('snapshot includes rows that live only in the WAL of the source database', async () => {
  const walDbPath = join(dir, 'wal-source.sqlite');
  const writer = new Database(walDbPath, { create: true });
  writer.run('PRAGMA journal_mode = WAL');
  writer.run('PRAGMA wal_autocheckpoint = 0');
  writer.run('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  writer.run("INSERT INTO thing (name) VALUES ('wal-only')");
  const snap = await snapshotSqlite(walDbPath);
  try {
    const reader = openReadOnly(snap.path);
    try {
      const rows = reader.query<{ name: string }, []>('SELECT name FROM thing').all();
      expect(rows.map((r) => r.name)).toEqual(['wal-only']);
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
    await snap.cleanup();
  }
});

test('snapshot falls back to immutable open when regular open throws SQLITE_CANTOPEN', async () => {
  const calls: Array<{ path: string; immutable: boolean }> = [];
  const fakeOpen: SnapshotOpenImpl = (path, opts) => {
    calls.push({ path, immutable: opts?.immutable === true });
    if (calls.length === 1) {
      const err = new Error('unable to open database file') as Error & { code?: string };
      err.code = 'SQLITE_CANTOPEN';
      throw err;
    }
    return openReadOnly(path, opts);
  };
  const snap = await snapshotSqlite(dbPath, { openImpl: fakeOpen });
  try {
    expect(calls).toEqual([
      { path: dbPath, immutable: false },
      { path: dbPath, immutable: true },
    ]);
  } finally {
    await snap.cleanup();
  }
});

test('snapshot propagates other errors after trying immutable fallback', async () => {
  let calls = 0;
  const fakeOpen: SnapshotOpenImpl = () => {
    calls++;
    const err = new Error('disk i/o error') as Error & { code?: string };
    err.code = 'SQLITE_IOERR';
    throw err;
  };
  await expect(snapshotSqlite(dbPath, { openImpl: fakeOpen })).rejects.toThrow('disk i/o error');
  expect(calls).toBe(2);
});
