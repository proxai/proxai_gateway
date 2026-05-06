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

/**
 * Like `getCursor`, but if the exact (app, hash, inode, table) key misses,
 * fall back to the same key with `sourceInode = NO_INODE_SENTINEL`.
 *
 * Rationale: the watermark-sync pre-flight seeds cursors with inode=0
 * because the server doesn't track inode. When the source poller later
 * discovers the file with a real inode, it uses this helper to inherit
 * the synced position. The poller then writes a fresh cursor under its
 * real inode via `setCursor`; the inode=0 placeholder remains as a
 * harmless artifact.
 */
export function getCursorWithFallback(db: Database, key: CursorKey): CursorState | null {
  const exact = getCursor(db, key);
  if (exact !== null) return exact;
  if ((key.sourceInode ?? NO_INODE_SENTINEL) === NO_INODE_SENTINEL) return null;
  return getCursor(db, { ...key, sourceInode: NO_INODE_SENTINEL });
}

const COUNT_CURSORS_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.cursors}`;

export function countCursors(db: Database): number {
  const row = db.query<{ count: number }, []>(COUNT_CURSORS_SQL).get();
  return row?.count ?? 0;
}
