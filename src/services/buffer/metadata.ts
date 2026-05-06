import type { Database } from 'bun:sqlite';

import { BUFFER_TABLES, METADATA_COLS, METADATA_KEYS } from 'services/buffer/buffer.constants.ts';

const UPSERT_METADATA_SQL = `
  INSERT INTO ${BUFFER_TABLES.metadata} (${METADATA_COLS.key}, ${METADATA_COLS.value})
  VALUES (?, ?)
  ON CONFLICT(${METADATA_COLS.key}) DO UPDATE SET ${METADATA_COLS.value} = excluded.${METADATA_COLS.value}
`;

const GET_METADATA_SQL = `
  SELECT ${METADATA_COLS.value} AS value FROM ${BUFFER_TABLES.metadata}
  WHERE ${METADATA_COLS.key} = ?
`;

export function setMetadata(db: Database, key: string, value: string): void {
  db.query(UPSERT_METADATA_SQL).run(key, value);
}

export function getMetadata(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>(GET_METADATA_SQL).get(key);
  return row?.value ?? null;
}

export function setLastPruneAt(db: Database, iso: string): void {
  setMetadata(db, METADATA_KEYS.lastPruneAt, iso);
}

export function getLastPruneAt(db: Database): string | null {
  return getMetadata(db, METADATA_KEYS.lastPruneAt);
}
