import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  columnExists,
  listTables,
  openReadOnly,
  openReadWrite,
  snapshotSqlite,
  tableExists,
} from 'core/io/sqlite';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sqlite-'));
  dbPath = join(dir, 'src.sqlite');
  const seed = new Database(dbPath, { create: true });
  seed.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  seed.exec("INSERT INTO thing (name) VALUES ('a'), ('b'), ('c')");
  seed.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('openReadOnly cannot write', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(() => db.exec("INSERT INTO thing (name) VALUES ('fail')")).toThrow();
  } finally {
    db.close();
  }
});

test('openReadWrite enables WAL', () => {
  const path = join(dir, 'rw.sqlite');
  const db = openReadWrite(path);
  try {
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(mode?.journal_mode.toLowerCase()).toBe('wal');
  } finally {
    db.close();
  }
});

test('tableExists / listTables / columnExists', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(tableExists(db, 'thing')).toBe(true);
    expect(tableExists(db, 'missing')).toBe(false);
    expect(listTables(db)).toEqual(['thing']);
    expect(columnExists(db, 'thing', 'name')).toBe(true);
    expect(columnExists(db, 'thing', 'absent')).toBe(false);
  } finally {
    db.close();
  }
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
