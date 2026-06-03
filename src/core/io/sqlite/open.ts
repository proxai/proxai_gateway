import { chmodSync } from 'node:fs';

import { Database, constants } from 'bun:sqlite';

export interface OpenReadOnlyOptions {
  immutable?: boolean;
}

export function openReadOnly(path: string, _options?: OpenReadOnlyOptions): Database {
  const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
  const db = new Database(path, flags);
  db.run('PRAGMA busy_timeout = 5000;');
  return db;
}

export function openReadWrite(path: string): Database {
  const db = new Database(path, { create: true });
  db.run('PRAGMA busy_timeout = 5000;');
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');

  if (process.platform !== 'win32') {
    setModeSilent(path, 0o600);
    setModeSilent(`${path}-wal`, 0o600);
    setModeSilent(`${path}-shm`, 0o600);
  }
  return db;
}

function setModeSilent(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {}
}
