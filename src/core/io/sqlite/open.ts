import { chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Database, constants } from 'bun:sqlite';

export interface OpenReadOnlyOptions {
  immutable?: boolean;
}

export function openReadOnly(path: string, options?: OpenReadOnlyOptions): Database {
  const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
  const target = options?.immutable === true ? immutableUri(path) : path;
  const db = new Database(target, flags);
  db.run('PRAGMA busy_timeout = 5000;');
  return db;
}

function immutableUri(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set('immutable', '1');
  return url.href;
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
