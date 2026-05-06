import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { listTables, tableExists } from 'core/io/sqlite';
import { BUFFER_TABLES, openInMemoryBufferDb } from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('schema initialization creates the upload_batches table', () => {
  expect(tableExists(db, BUFFER_TABLES.batches)).toBe(true);
});

test('schema initialization creates the source_cursors table', () => {
  expect(tableExists(db, BUFFER_TABLES.cursors)).toBe(true);
});

test('schema initialization creates the upload_receipts table', () => {
  expect(tableExists(db, BUFFER_TABLES.receipts)).toBe(true);
});

test('listTables shows the three buffer tables', () => {
  expect(listTables(db).toSorted()).toEqual(
    [BUFFER_TABLES.batches, BUFFER_TABLES.cursors, BUFFER_TABLES.receipts].toSorted(),
  );
});

test('opening twice produces equivalent schemas (CREATE IF NOT EXISTS)', () => {
  const second = openInMemoryBufferDb();
  try {
    expect(tableExists(second, BUFFER_TABLES.batches)).toBe(true);
    expect(tableExists(second, BUFFER_TABLES.cursors)).toBe(true);
    expect(tableExists(second, BUFFER_TABLES.receipts)).toBe(true);
  } finally {
    second.close();
  }
});
