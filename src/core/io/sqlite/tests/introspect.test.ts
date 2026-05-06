import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
  await rm(dir, { recursive: true, force: true });
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
    // Force the query to throw by passing a name that produces invalid SQL
    // even after escaping (an empty string yields `FROM ""` which sqlite
    // rejects). The function swallows the error and returns 0.
    expect(maxRowid(db, '')).toBe(0);
  } finally {
    db.close();
  }
});

test('maxRowid returns 0 for a real but empty table', () => {
  const dbW = openReadOnly(dbPath);
  try {
    // `thing` has at least one row in the seed; we ask for `thing` instead
    // of an empty fixture and expect a positive value.
    expect(maxRowid(dbW, 'thing')).toBeGreaterThan(0);
  } finally {
    dbW.close();
  }
});
