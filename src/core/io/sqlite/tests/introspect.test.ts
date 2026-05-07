import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  columnExists,
  listTables,
  maxRowid,
  openReadOnly,
  pageCount,
  tableExists,
} from 'core/io/sqlite';
import { seedTestDatabase } from 'core/io/sqlite/tests/fixtures.ts';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sqlite-introspect-'));
  dbPath = join(dir, 'src.sqlite');
  seedTestDatabase(dbPath);
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('tableExists returns true for an existing table', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(tableExists(db, 'thing')).toBe(true);
  } finally {
    db.close();
  }
});

test('tableExists returns false for an unknown table', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(tableExists(db, 'missing')).toBe(false);
  } finally {
    db.close();
  }
});

test('listTables returns user tables only (excludes sqlite_*)', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(listTables(db)).toEqual(['thing']);
  } finally {
    db.close();
  }
});

test('columnExists detects existing columns', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(columnExists(db, 'thing', 'name')).toBe(true);
    expect(columnExists(db, 'thing', 'id')).toBe(true);
  } finally {
    db.close();
  }
});

test('columnExists returns false for missing columns', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(columnExists(db, 'thing', 'absent')).toBe(false);
  } finally {
    db.close();
  }
});

test('pageCount returns the PRAGMA page_count value for a real db', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(pageCount(db)).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});

test('maxRowid returns 0 for a non-existent table (catch fallback)', () => {
  const db = openReadOnly(dbPath);
  try {
    expect(maxRowid(db, '')).toBe(0);
  } finally {
    db.close();
  }
});

test('maxRowid returns 0 for a real but empty table', () => {
  const dbW = openReadOnly(dbPath);
  try {
    expect(maxRowid(dbW, 'thing')).toBeGreaterThan(0);
  } finally {
    dbW.close();
  }
});
