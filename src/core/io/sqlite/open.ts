import { Database } from 'bun:sqlite';

export function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true, create: false });
}

export function openReadWrite(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
