import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { columnExists, listTables, tableExists } from 'core/io/sqlite';
import {
  BUFFER_TABLES,
  openBufferDb,
  openInMemoryBufferDb,
  openReadOnlyBufferDb,
} from 'services/buffer';

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

test('listTables shows all buffer tables including quarantined records', () => {
  expect(listTables(db).toSorted()).toEqual(
    [
      BUFFER_TABLES.batches,
      BUFFER_TABLES.cursors,
      BUFFER_TABLES.receipts,
      BUFFER_TABLES.metadata,
      BUFFER_TABLES.daemonState,
      BUFFER_TABLES.quarantined,
      BUFFER_TABLES.resyncEvents,
    ].toSorted(),
  );
});

test('schema initialization creates the daemon_state table', () => {
  expect(tableExists(db, BUFFER_TABLES.daemonState)).toBe(true);
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

test('migrates pre-existing upload_batches table by adding failed_at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-migrate-batches-'));
  try {
    const path = join(dir, 'old-buffer-batches.db');

    const seed = new Database(path, { create: true });
    seed.run(
      `CREATE TABLE upload_batches (
         capture_id TEXT PRIMARY KEY NOT NULL,
         source_app TEXT NOT NULL,
         source_kind TEXT NOT NULL,
         source_path TEXT NOT NULL,
         source_path_hash TEXT NOT NULL,
         source_inode INTEGER,
         watermark_kind TEXT NOT NULL,
         watermark_start INTEGER NOT NULL,
         watermark_end INTEGER NOT NULL,
         watermark_table TEXT,
         agent_schema_version TEXT NOT NULL,
         gateway_version TEXT NOT NULL,
         captured_at_utc TEXT NOT NULL,
         body_format TEXT NOT NULL,
         body_compression TEXT NOT NULL,
         body BLOB NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         last_error TEXT
       )`,
    );
    seed.close();

    const opened = openBufferDb(path);
    try {
      expect(columnExists(opened, BUFFER_TABLES.batches, 'failed_at')).toBe(true);
    } finally {
      opened.close();
    }
  } finally {
    await rmRecursive(dir);
  }
});

test('migrates pre-existing upload_batches table by adding source_platform', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-migrate-platform-'));
  try {
    const path = join(dir, 'old-buffer-platform.db');

    const seed = new Database(path, { create: true });
    seed.run(
      `CREATE TABLE upload_batches (
         capture_id TEXT PRIMARY KEY NOT NULL,
         source_app TEXT NOT NULL,
         source_kind TEXT NOT NULL,
         source_path TEXT NOT NULL,
         source_path_hash TEXT NOT NULL,
         source_inode INTEGER,
         watermark_kind TEXT NOT NULL,
         watermark_start INTEGER NOT NULL,
         watermark_end INTEGER NOT NULL,
         watermark_table TEXT,
         agent_schema_version TEXT NOT NULL,
         gateway_version TEXT NOT NULL,
         captured_at_utc TEXT NOT NULL,
         body_format TEXT NOT NULL,
         body_compression TEXT NOT NULL,
         body BLOB NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         last_error TEXT
       )`,
    );
    seed.close();

    const opened = openBufferDb(path);
    try {
      expect(columnExists(opened, BUFFER_TABLES.batches, 'source_platform')).toBe(true);
    } finally {
      opened.close();
    }

    const reopened = openBufferDb(path);
    try {
      expect(columnExists(reopened, BUFFER_TABLES.batches, 'source_platform')).toBe(true);
    } finally {
      reopened.close();
    }
  } finally {
    await rmRecursive(dir);
  }
});

test('fresh upload_batches schema includes source_platform', () => {
  expect(columnExists(db, BUFFER_TABLES.batches, 'source_platform')).toBe(true);
});

test('migrates pre-existing receipts table by adding user_prompt, source_path, etc.', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-migrate-receipts-'));
  try {
    const path = join(dir, 'old-buffer-receipts.db');

    const seed = new Database(path, { create: true });
    seed.run(
      `CREATE TABLE upload_receipts (
         capture_id TEXT PRIMARY KEY NOT NULL,
         source_app TEXT NOT NULL,
         source_path_hash TEXT NOT NULL,
         watermark_kind TEXT NOT NULL,
         watermark_start INTEGER NOT NULL,
         watermark_end INTEGER NOT NULL,
         watermark_table TEXT,
         delivered_at TEXT NOT NULL,
         idempotent_on_server INTEGER NOT NULL DEFAULT 0
       )`,
    );
    seed.close();

    const opened = openBufferDb(path);
    try {
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'user_prompt')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'user_prompt_added_at')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'source_path')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'agent_schema_version')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'gateway_version')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'captured_at_utc')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'attempts')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'source_inode')).toBe(true);
      expect(columnExists(opened, BUFFER_TABLES.receipts, 'shipped_bytes')).toBe(true);
    } finally {
      opened.close();
    }
  } finally {
    await rmRecursive(dir);
  }
});

test('openReadOnlyBufferDb opens an existing database in readonly mode without migrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-readonly-'));
  try {
    const path = join(dir, 'test-readonly.db');

    // 1. Create a database file with a basic table schema, but missing the new migrated columns
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

    // 2. Open it with openReadOnlyBufferDb
    const dbRo = openReadOnlyBufferDb(path);
    try {
      // It should not write
      expect(() =>
        dbRo.run(
          "INSERT INTO source_cursors (source_app, source_path_hash, source_path, last_polled_at) VALUES ('a', 'b', 'c', 'd')",
        ),
      ).toThrow();

      // The new migrated columns should NOT exist yet because no schema migrations were performed
      expect(columnExists(dbRo, BUFFER_TABLES.cursors, 'last_seen_size_bytes')).toBe(false);
    } finally {
      dbRo.close();
    }
  } finally {
    await rmRecursive(dir);
  }
});
