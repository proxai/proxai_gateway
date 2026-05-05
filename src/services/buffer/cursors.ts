import type { Database } from 'bun:sqlite';

import { nowIsoUtc } from 'core/utils';
import {
  BUFFER_TABLES,
  CURSOR_COLS,
  NO_INODE_SENTINEL,
  NO_TABLE_SENTINEL,
} from 'services/buffer/buffer.constants.ts';
import type { CursorKey, CursorState, SetCursorInput } from 'services/buffer/buffer.types.ts';

interface CursorRow {
  watermark_end: number;
  last_polled_at: string;
  consecutive_errors: number;
}

const GET_CURSOR_SQL = `
  SELECT ${CURSOR_COLS.watermarkEnd}, ${CURSOR_COLS.lastPolledAt}, ${CURSOR_COLS.consecutiveErrors}
  FROM ${BUFFER_TABLES.cursors}
  WHERE ${CURSOR_COLS.sourceApp} = ?
    AND ${CURSOR_COLS.sourcePathHash} = ?
    AND ${CURSOR_COLS.sourceInode} = ?
    AND ${CURSOR_COLS.watermarkTable} = ?
`;

const UPSERT_CURSOR_SQL = `
  INSERT INTO ${BUFFER_TABLES.cursors} (
    ${CURSOR_COLS.sourceApp},
    ${CURSOR_COLS.sourcePathHash},
    ${CURSOR_COLS.sourcePath},
    ${CURSOR_COLS.sourceInode},
    ${CURSOR_COLS.watermarkTable},
    ${CURSOR_COLS.watermarkEnd},
    ${CURSOR_COLS.lastPolledAt},
    ${CURSOR_COLS.consecutiveErrors}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (
    ${CURSOR_COLS.sourceApp},
    ${CURSOR_COLS.sourcePathHash},
    ${CURSOR_COLS.sourceInode},
    ${CURSOR_COLS.watermarkTable}
  ) DO UPDATE SET
    ${CURSOR_COLS.sourcePath} = excluded.${CURSOR_COLS.sourcePath},
    ${CURSOR_COLS.watermarkEnd} = excluded.${CURSOR_COLS.watermarkEnd},
    ${CURSOR_COLS.lastPolledAt} = excluded.${CURSOR_COLS.lastPolledAt},
    ${CURSOR_COLS.consecutiveErrors} = excluded.${CURSOR_COLS.consecutiveErrors}
`;

export function getCursor(db: Database, key: CursorKey): CursorState | null {
  const row = db
    .query<CursorRow, [string, string, number, string]>(GET_CURSOR_SQL)
    .get(
      key.sourceApp,
      key.sourcePathHash,
      key.sourceInode ?? NO_INODE_SENTINEL,
      key.watermarkTable ?? NO_TABLE_SENTINEL,
    );
  if (row === null) return null;
  return {
    watermarkEnd: row.watermark_end,
    lastPolledAt: row.last_polled_at,
    consecutiveErrors: row.consecutive_errors,
  };
}

export function setCursor(db: Database, input: SetCursorInput): void {
  db.query(UPSERT_CURSOR_SQL).run(
    input.sourceApp,
    input.sourcePathHash,
    input.sourcePath,
    input.sourceInode ?? NO_INODE_SENTINEL,
    input.watermarkTable ?? NO_TABLE_SENTINEL,
    input.watermarkEnd,
    nowIsoUtc(),
    input.consecutiveErrors ?? 0,
  );
}
