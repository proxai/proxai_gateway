import type { Database } from 'bun:sqlite';

import {
  BUFFER_TABLES,
  RECEIPT_COLS,
  RESYNC_EVENT_COLS,
} from 'services/buffer/buffer.constants.ts';

export interface LastUploadRow {
  readonly userPromptAddedAt: string | null;
  readonly sourceApp: string;
  readonly userPrompt: string | null;
  readonly shippedBytes: number | null;
  readonly deliveredAt: string;
  readonly idempotentOnServer: boolean;
}

export interface ResyncStats {
  readonly count: number;
  readonly lastRecoveredAt: string | null;
}

interface RawLastUploadRow {
  user_prompt_added_at: string | null;
  source_app: string;
  user_prompt: string | null;
  shipped_bytes: number | null;
  delivered_at: string;
  idempotent_on_server: number;
}

interface RawResyncStats {
  count: number;
  last_recovered_at: string | null;
}

const LAST_UPLOADS_SQL = `
  SELECT
    ${RECEIPT_COLS.userPromptAddedAt} AS user_prompt_added_at,
    ${RECEIPT_COLS.sourceApp} AS source_app,
    ${RECEIPT_COLS.userPrompt} AS user_prompt,
    ${RECEIPT_COLS.shippedBytes} AS shipped_bytes,
    ${RECEIPT_COLS.deliveredAt} AS delivered_at,
    ${RECEIPT_COLS.idempotentOnServer} AS idempotent_on_server
  FROM ${BUFFER_TABLES.receipts}
  ORDER BY ${RECEIPT_COLS.deliveredAt} DESC
  LIMIT ?
`;

const RESYNC_STATS_SQL = `
  SELECT
    COUNT(*) AS count,
    MAX(${RESYNC_EVENT_COLS.recoveredAt}) AS last_recovered_at
  FROM ${BUFFER_TABLES.resyncEvents}
`;

const COUNT_IDEMPOTENT_RECEIPTS_SQL = `
  SELECT COUNT(*) AS count
  FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.idempotentOnServer} = 1
`;

export function queryLastUploads(db: Database, limit: number): LastUploadRow[] {
  const rows = db.query<RawLastUploadRow, [number]>(LAST_UPLOADS_SQL).all(limit);
  return rows.map((row) => ({
    userPromptAddedAt: row.user_prompt_added_at,
    sourceApp: row.source_app,
    userPrompt: row.user_prompt,
    shippedBytes: row.shipped_bytes,
    deliveredAt: row.delivered_at,
    idempotentOnServer: row.idempotent_on_server !== 0,
  }));
}

export function queryResyncStats(db: Database): ResyncStats {
  const row = db.query<RawResyncStats, []>(RESYNC_STATS_SQL).get();
  return {
    count: row?.count ?? 0,
    lastRecoveredAt: row?.last_recovered_at ?? null,
  };
}

export function countIdempotentReceipts(db: Database): number {
  const row = db.query<{ count: number }, []>(COUNT_IDEMPOTENT_RECEIPTS_SQL).get();
  return row?.count ?? 0;
}
