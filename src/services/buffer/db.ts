import { Database } from 'bun:sqlite';

import { columnExists, openReadWrite } from 'core/io/sqlite';
import {
  BATCH_PATH_HASH_INDEX_DDL,
  BATCH_STATUS_INDEX_DDL,
  BATCH_TABLE_DDL,
  BUFFER_TABLES,
  CURSOR_ALTER_ADD_LAST_SEEN_PAGE_COUNT_DDL,
  CURSOR_ALTER_ADD_LAST_SEEN_SIZE_DDL,
  CURSOR_COLS,
  CURSOR_TABLE_DDL,
  METADATA_TABLE_DDL,
  RECEIPT_DELIVERED_AT_INDEX_DDL,
  RECEIPT_PATH_HASH_INDEX_DDL,
  RECEIPT_TABLE_DDL,
} from 'services/buffer/buffer.constants.ts';

export function openBufferDb(path: string): Database {
  const db = openReadWrite(path);
  initializeSchema(db);
  return db;
}

export function openInMemoryBufferDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

function initializeSchema(db: Database): void {
  db.run(BATCH_TABLE_DDL);
  db.run(BATCH_STATUS_INDEX_DDL);
  db.run(BATCH_PATH_HASH_INDEX_DDL);
  db.run(CURSOR_TABLE_DDL);
  migrateCursorVacuumColumns(db);
  db.run(RECEIPT_TABLE_DDL);
  db.run(RECEIPT_PATH_HASH_INDEX_DDL);
  db.run(RECEIPT_DELIVERED_AT_INDEX_DDL);
  db.run(METADATA_TABLE_DDL);
}

function migrateCursorVacuumColumns(db: Database): void {
  if (!columnExists(db, BUFFER_TABLES.cursors, CURSOR_COLS.lastSeenSizeBytes)) {
    db.run(CURSOR_ALTER_ADD_LAST_SEEN_SIZE_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.cursors, CURSOR_COLS.lastSeenPageCount)) {
    db.run(CURSOR_ALTER_ADD_LAST_SEEN_PAGE_COUNT_DDL);
  }
}
