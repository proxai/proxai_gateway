import { chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Database } from 'bun:sqlite';

export interface OpenReadOnlyOptions {
  immutable?: boolean;
}

export function openReadOnly(path: string, options: OpenReadOnlyOptions = {}): Database {
  if (options.immutable === true) {
    const url = pathToFileURL(path);
    url.searchParams.set('immutable', '1');
    return new Database(url.toString(), { readonly: true, create: false });
  }
  return new Database(path, { readonly: true, create: false });
}

export function openReadWrite(path: string): Database {
  const db = new Database(path, { create: true });
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
