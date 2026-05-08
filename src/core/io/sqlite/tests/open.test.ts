import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReadOnly, openReadWrite } from 'core/io/sqlite';
import { seedTestDatabase } from 'core/io/sqlite/tests/fixtures.ts';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sqlite-open-'));
  dbPath = join(dir, 'src.sqlite');
  seedTestDatabase(dbPath);
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('openReadOnly cannot write', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(() => db.run("INSERT INTO thing (name) VALUES ('fail')")).toThrow();
  } finally {
    db.close();
  }
});

test('openReadOnly can read', () => {
  const db = openReadOnly(dbPath);
  try {
    const rows = db.query<{ name: string }, []>('SELECT name FROM thing ORDER BY id').all();
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  } finally {
    db.close();
  }
});

test('openReadWrite enables WAL journal mode', () => {
  const path = join(dir, 'rw.sqlite');
  const db = openReadWrite(path);
  try {
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(mode?.journal_mode.toLowerCase()).toBe('wal');
  } finally {
    db.close();
  }
});

test('openReadWrite enables foreign keys', () => {
  const path = join(dir, 'rw-fk.sqlite');
  const db = openReadWrite(path);
  try {
    const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);
  } finally {
    db.close();
  }
});

test('openReadOnly with immutable=true reads even when path contains spaces', () => {
  const spacedDir = join(dir, 'with space');
  const spacedPath = join(spacedDir, 'imm.sqlite');
  mkdirSync(spacedDir, { recursive: true });
  seedTestDatabase(spacedPath);
  const db = openReadOnly(spacedPath, { immutable: true });
  try {
    const rows = db.query<{ name: string }, []>('SELECT name FROM thing ORDER BY id').all();
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
  } finally {
    db.close();
  }
});

test('openReadOnly with immutable=true rejects writes', () => {
  const db = openReadOnly(dbPath, { immutable: true });
  try {
    expect(() => db.run("INSERT INTO thing (name) VALUES ('fail')")).toThrow();
  } finally {
    db.close();
  }
});
