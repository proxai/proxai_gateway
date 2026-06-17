import type { Database } from 'bun:sqlite';

import { currentGenerationNumber, nowIsoUtc, stripGenerationSuffix } from 'core/utils';
import {
  BUFFER_TABLES,
  CURSOR_COLS,
  NO_INODE_SENTINEL,
  NO_TABLE_SENTINEL,
} from 'services/buffer/buffer.constants.ts';
import type { CursorKey, CursorState, SetCursorInput } from 'services/buffer/buffer.types.ts';
import type { SourceApp } from 'services/contract';

interface CursorRow {
  watermark_end: number;
  last_polled_at: string;
  consecutive_errors: number;
  last_seen_size_bytes: number | null;
  last_seen_page_count: number | null;
}

const GET_CURSOR_SQL = `
  SELECT
    ${CURSOR_COLS.watermarkEnd},
    ${CURSOR_COLS.lastPolledAt},
    ${CURSOR_COLS.consecutiveErrors},
    ${CURSOR_COLS.lastSeenSizeBytes},
    ${CURSOR_COLS.lastSeenPageCount}
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
    ${CURSOR_COLS.consecutiveErrors},
    ${CURSOR_COLS.lastSeenSizeBytes},
    ${CURSOR_COLS.lastSeenPageCount}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (
    ${CURSOR_COLS.sourceApp},
    ${CURSOR_COLS.sourcePathHash},
    ${CURSOR_COLS.sourceInode},
    ${CURSOR_COLS.watermarkTable}
  ) DO UPDATE SET
    ${CURSOR_COLS.sourcePath} = excluded.${CURSOR_COLS.sourcePath},
    ${CURSOR_COLS.watermarkEnd} = excluded.${CURSOR_COLS.watermarkEnd},
    ${CURSOR_COLS.lastPolledAt} = excluded.${CURSOR_COLS.lastPolledAt},
    ${CURSOR_COLS.consecutiveErrors} = excluded.${CURSOR_COLS.consecutiveErrors},
    ${CURSOR_COLS.lastSeenSizeBytes} = excluded.${CURSOR_COLS.lastSeenSizeBytes},
    ${CURSOR_COLS.lastSeenPageCount} = excluded.${CURSOR_COLS.lastSeenPageCount}
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
    lastSeenSizeBytes: row.last_seen_size_bytes,
    lastSeenPageCount: row.last_seen_page_count,
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
    input.lastSeenSizeBytes ?? null,
    input.lastSeenPageCount ?? null,
  );
}

export function getCursorWithFallback(db: Database, key: CursorKey): CursorState | null {
  const exact = getCursor(db, key);
  if (exact !== null) return exact;
  if ((key.sourceInode ?? NO_INODE_SENTINEL) === NO_INODE_SENTINEL) return null;
  return getCursor(db, { ...key, sourceInode: NO_INODE_SENTINEL });
}

export function getHighestGenerationPath(
  db: Database,
  sourceApp: SourceApp,
  baseSourcePath: string,
): string {
  const base = stripGenerationSuffix(baseSourcePath);
  const rows = db
    .query<
      { source_path: string },
      [string, string, string]
    >(`SELECT DISTINCT source_path FROM ${BUFFER_TABLES.cursors} WHERE source_app = ? AND (source_path = ? OR source_path LIKE ?)`)
    .all(sourceApp, base, `${base}#gen=%`);
  let maxGen = 0;
  let resultPath = base;
  for (const row of rows) {
    const gen = currentGenerationNumber(row.source_path);
    if (gen > maxGen) {
      maxGen = gen;
      resultPath = row.source_path;
    }
  }
  return resultPath;
}

const COUNT_CURSORS_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.cursors}`;

export function countCursors(db: Database): number {
  const row = db.query<{ count: number }, []>(COUNT_CURSORS_SQL).get();
  return row?.count ?? 0;
}

const HAS_CURSOR_FOR_APP_SQL = `
  SELECT 1 FROM ${BUFFER_TABLES.cursors}
  WHERE ${CURSOR_COLS.sourceApp} = ?
  LIMIT 1
`;

export function hasAnyCursor(db: Database, sourceApp: SourceApp): boolean {
  const row = db.query<{ '1': number }, [string]>(HAS_CURSOR_FOR_APP_SQL).get(sourceApp);
  return row !== null;
}

export function setCursorFromRegression(
  db: Database,
  batch: {
    sourceApp: string;
    sourcePath: string;
    sourcePathHash: string;
    sourceInode: number | null;
    watermarkTable: string | null;
  },
  watermarkEnd: number,
): void {
  const sourceApp = batch.sourceApp as SourceApp;
  const prior = getCursor(db, {
    sourceApp,
    sourcePathHash: batch.sourcePathHash,
    sourceInode: batch.sourceInode,
    watermarkTable: batch.watermarkTable,
  });
  setCursor(db, {
    sourceApp,
    sourcePathHash: batch.sourcePathHash,
    sourcePath: batch.sourcePath,
    sourceInode: batch.sourceInode,
    watermarkTable: batch.watermarkTable,
    watermarkEnd,
    lastSeenSizeBytes: prior?.lastSeenSizeBytes ?? null,
    lastSeenPageCount: prior?.lastSeenPageCount ?? null,
  });
}

export function countCapturedConversations(db: Database): Record<SourceApp, number> {
  const claudeCodeRow = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(DISTINCT ${CURSOR_COLS.sourcePath}) AS count FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ?`)
    .get('claude-code');

  const cursorRow = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(DISTINCT ${CURSOR_COLS.sourcePath}) AS count FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ?`)
    .get('cursor');

  const claudeDesktopRow = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(DISTINCT ${CURSOR_COLS.sourcePath}) AS count FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ?`)
    .get('claude-desktop');

  const geminiRow = db
    .query<
      { count: number },
      [string]
    >(`SELECT COUNT(DISTINCT ${CURSOR_COLS.sourcePath}) AS count FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ?`)
    .get('gemini');

  const codexThreadsRow = db
    .query<
      { total: number },
      [string, string]
    >(`SELECT COALESCE(SUM(${CURSOR_COLS.watermarkEnd} - 1), 0) AS total FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ? AND ${CURSOR_COLS.watermarkTable} = ?`)
    .get('codex', 'threads');

  const codexRolloutsRow = db
    .query<
      { count: number },
      [string, string]
    >(`SELECT COUNT(DISTINCT ${CURSOR_COLS.sourcePath}) AS count FROM ${BUFFER_TABLES.cursors} WHERE ${CURSOR_COLS.sourceApp} = ? AND ${CURSOR_COLS.watermarkTable} = ?`)
    .get('codex', NO_TABLE_SENTINEL);

  return {
    'claude-code': claudeCodeRow?.count ?? 0,
    cursor: cursorRow?.count ?? 0,
    'claude-desktop': claudeDesktopRow?.count ?? 0,
    codex: (codexThreadsRow?.total ?? 0) + (codexRolloutsRow?.count ?? 0),
    gemini: geminiRow?.count ?? 0,
  };
}
