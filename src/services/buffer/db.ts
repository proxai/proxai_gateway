import { Database } from 'bun:sqlite';

import { openReadWrite } from 'core/io/sqlite';
import {
  BATCH_PATH_HASH_INDEX_DDL,
  BATCH_STATUS_INDEX_DDL,
  BATCH_TABLE_DDL,
  CURSOR_TABLE_DDL,
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
}
