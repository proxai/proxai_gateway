import { chmodSync } from 'node:fs';

import { Database } from 'bun:sqlite';

export function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true, create: false });
}

export function openReadWrite(path: string): Database {
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  db.run('PRAGMA foreign_keys = ON;');
  // Owner-only access on POSIX; SQLite manages -wal/-shm, so secure those too
  // when present. Errors (e.g. companion files not yet materialized) are
  // swallowed — the next open will retry.
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
  } catch {
    // best-effort; missing companion files are normal before first write
  }
}
