import { Database } from 'bun:sqlite';

import { columnExists, openReadOnly, openReadWrite } from 'core/io/sqlite';
import {
  BATCH_ALTER_ADD_FAILED_AT_DDL,
  BATCH_ALTER_ADD_SOURCE_PLATFORM_DDL,
  BATCH_COLS,
  BATCH_PATH_HASH_INDEX_DDL,
  BATCH_STATUS_INDEX_DDL,
  BATCH_TABLE_DDL,
  BUFFER_TABLES,
  CURSOR_ALTER_ADD_LAST_SEEN_PAGE_COUNT_DDL,
  CURSOR_ALTER_ADD_LAST_SEEN_SIZE_DDL,
  CURSOR_COLS,
  CURSOR_TABLE_DDL,
  METADATA_TABLE_DDL,
  QUARANTINE_AT_INDEX_DDL,
  QUARANTINE_SOURCE_APP_INDEX_DDL,
  QUARANTINE_TABLE_DDL,
  RECEIPT_ALTER_ADD_AGENT_SCHEMA_VERSION_DDL,
  RECEIPT_ALTER_ADD_ATTEMPTS_DDL,
  RECEIPT_ALTER_ADD_CAPTURED_AT_UTC_DDL,
  RECEIPT_ALTER_ADD_GATEWAY_VERSION_DDL,
  RECEIPT_ALTER_ADD_SHIPPED_BYTES_DDL,
  RECEIPT_ALTER_ADD_SOURCE_INODE_DDL,
  RECEIPT_ALTER_ADD_SOURCE_PATH_DDL,
  RECEIPT_ALTER_ADD_USER_PROMPT_ADDED_AT_DDL,
  RECEIPT_ALTER_ADD_USER_PROMPT_DDL,
  RECEIPT_COLS,
  RECEIPT_DELIVERED_AT_INDEX_DDL,
  RECEIPT_PATH_HASH_INDEX_DDL,
  RECEIPT_TABLE_DDL,
  RESYNC_EVENTS_RECOVERED_AT_INDEX_DDL,
  RESYNC_EVENTS_TABLE_DDL,
} from 'services/buffer/buffer.constants.ts';
import {
  DAEMON_STATE_TABLE_DDL,
  migrateDaemonStateMachineSnapshots,
} from 'services/buffer/daemon-state.ts';

export function openBufferDb(path: string): Database {
  const db = openReadWrite(path);
  initializeSchema(db);
  return db;
}

export function openReadOnlyBufferDb(path: string): Database {
  return openReadOnly(path);
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
  migrateBatchFailedAtColumn(db);
  migrateBatchSourcePlatformColumn(db);
  db.run(CURSOR_TABLE_DDL);
  migrateCursorVacuumColumns(db);
  db.run(RECEIPT_TABLE_DDL);
  db.run(RECEIPT_PATH_HASH_INDEX_DDL);
  db.run(RECEIPT_DELIVERED_AT_INDEX_DDL);
  migrateReceiptDisplayColumns(db);
  db.run(METADATA_TABLE_DDL);
  db.run(DAEMON_STATE_TABLE_DDL);
  migrateDaemonStateMachineSnapshots(db);
  db.run(QUARANTINE_TABLE_DDL);
  db.run(QUARANTINE_SOURCE_APP_INDEX_DDL);
  db.run(QUARANTINE_AT_INDEX_DDL);
  db.run(RESYNC_EVENTS_TABLE_DDL);
  db.run(RESYNC_EVENTS_RECOVERED_AT_INDEX_DDL);
}

function migrateBatchFailedAtColumn(db: Database): void {
  if (!columnExists(db, BUFFER_TABLES.batches, BATCH_COLS.failedAt)) {
    db.run(BATCH_ALTER_ADD_FAILED_AT_DDL);
  }
}

function migrateBatchSourcePlatformColumn(db: Database): void {
  if (!columnExists(db, BUFFER_TABLES.batches, BATCH_COLS.sourcePlatform)) {
    db.run(BATCH_ALTER_ADD_SOURCE_PLATFORM_DDL);
  }
}

function migrateCursorVacuumColumns(db: Database): void {
  if (!columnExists(db, BUFFER_TABLES.cursors, CURSOR_COLS.lastSeenSizeBytes)) {
    db.run(CURSOR_ALTER_ADD_LAST_SEEN_SIZE_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.cursors, CURSOR_COLS.lastSeenPageCount)) {
    db.run(CURSOR_ALTER_ADD_LAST_SEEN_PAGE_COUNT_DDL);
  }
}

function migrateReceiptDisplayColumns(db: Database): void {
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.userPrompt)) {
    db.run(RECEIPT_ALTER_ADD_USER_PROMPT_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.userPromptAddedAt)) {
    db.run(RECEIPT_ALTER_ADD_USER_PROMPT_ADDED_AT_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.sourcePath)) {
    db.run(RECEIPT_ALTER_ADD_SOURCE_PATH_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.agentSchemaVersion)) {
    db.run(RECEIPT_ALTER_ADD_AGENT_SCHEMA_VERSION_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.gatewayVersion)) {
    db.run(RECEIPT_ALTER_ADD_GATEWAY_VERSION_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.capturedAtUtc)) {
    db.run(RECEIPT_ALTER_ADD_CAPTURED_AT_UTC_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.attempts)) {
    db.run(RECEIPT_ALTER_ADD_ATTEMPTS_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.sourceInode)) {
    db.run(RECEIPT_ALTER_ADD_SOURCE_INODE_DDL);
  }
  if (!columnExists(db, BUFFER_TABLES.receipts, RECEIPT_COLS.shippedBytes)) {
    db.run(RECEIPT_ALTER_ADD_SHIPPED_BYTES_DDL);
  }
}
