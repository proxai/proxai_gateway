import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { columnExists, listTables, tableExists } from 'core/io/sqlite';
import { BUFFER_TABLES, openBufferDb, openInMemoryBufferDb } from 'services/buffer';

let db: SqliteDatabase;

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

test('schema initialization creates the buffer_metadata table', () => {
  expect(tableExists(db, BUFFER_TABLES.metadata)).toBe(true);
});

test('listTables shows the four buffer tables', () => {
  expect(listTables(db).toSorted()).toEqual(
    [
      BUFFER_TABLES.batches,
      BUFFER_TABLES.cursors,
      BUFFER_TABLES.receipts,
      BUFFER_TABLES.metadata,
    ].toSorted(),
  );
});

test('opening twice produces equivalent schemas (CREATE IF NOT EXISTS)', () => {
  const second = openInMemoryBufferDb();
  try {
    expect(tableExists(second, BUFFER_TABLES.batches)).toBe(true);
    expect(tableExists(second, BUFFER_TABLES.cursors)).toBe(true);
    expect(tableExists(second, BUFFER_TABLES.receipts)).toBe(true);
    expect(tableExists(second, BUFFER_TABLES.metadata)).toBe(true);
  } finally {
    second.close();
  }
});

test('migrates pre-existing buffer DB by adding last_seen_size_bytes / last_seen_page_count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-migrate-'));
  try {
    const path = join(dir, 'old-buffer.db');

    const seed = new Database(path, { create: true });
    seed.run(
      `CREATE TABLE source_cursors (
         source_app TEXT NOT NULL,
         source_path_hash TEXT NOT NULL,
         source_path TEXT NOT NULL,
         source_inode INTEGER NOT NULL DEFAULT -1,
         watermark_table TEXT NOT NULL DEFAULT '__none__',
         watermark_end INTEGER NOT NULL DEFAULT 0,
         last_polled_at TEXT NOT NULL,
         consecutive_errors INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (source_app, source_path_hash, source_inode, watermark_table)
       )`,
    );
    seed.close();

    const opened = openBufferDb(path);
    try {
      expect(columnExists(opened, BUFFER_TABLES.cursors, 'last_seen_size_bytes')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.cursors, 'last_seen_page_count')).toBe(true);
    } finally {
      opened.close();
    }
  } finally {
    await rmRecursive(dir);
  }
});
