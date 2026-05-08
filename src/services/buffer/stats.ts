import type { Database } from 'bun:sqlite';

import {
  BATCH_COLS,
  BATCH_STATUS,
  BUFFER_TABLES,
  RECEIPT_COLS,
} from 'services/buffer/buffer.constants.ts';
import type { BatchStatus, BufferCounts } from 'services/buffer/buffer.types.ts';
import { countReceipts } from 'services/buffer/receipts.ts';
import type { SourceApp } from 'services/contract';

const TOTAL_PENDING_BYTES_SQL = `
  SELECT COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS total
  FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.pending}'
`;

const TOTAL_FAILED_BYTES_SQL = `
  SELECT COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS total
  FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.failed}'
`;

const COUNT_BY_STATUS_SQL = `
  SELECT ${BATCH_COLS.status}, COUNT(*) AS count
  FROM ${BUFFER_TABLES.batches}
  GROUP BY ${BATCH_COLS.status}
`;

export function totalPendingBytes(db: Database): number {
  const row = db.query<{ total: number }, []>(TOTAL_PENDING_BYTES_SQL).get();
  return row?.total ?? 0;
}

export function totalFailedBytes(db: Database): number {
  const row = db.query<{ total: number }, []>(TOTAL_FAILED_BYTES_SQL).get();
  return row?.total ?? 0;
}

export function countByStatus(db: Database): BufferCounts {
  const rows = db.query<{ status: string; count: number }, []>(COUNT_BY_STATUS_SQL).all();
  const counts: BufferCounts = { pending: 0, failed: 0, delivered: 0 };
  for (const row of rows) {
    const status = row.status as BatchStatus;
    if (status === 'pending' || status === 'failed') {
      counts[status] = row.count;
    }
  }
  counts.delivered = countReceipts(db);
  return counts;
}

const COUNT_BATCHES_BY_SOURCE_SQL = `
  SELECT ${BATCH_COLS.sourceApp} AS source_app, ${BATCH_COLS.status} AS status, COUNT(*) AS count
  FROM ${BUFFER_TABLES.batches}
  GROUP BY ${BATCH_COLS.sourceApp}, ${BATCH_COLS.status}
`;

const COUNT_RECEIPTS_BY_SOURCE_SQL = `
  SELECT ${RECEIPT_COLS.sourceApp} AS source_app, COUNT(*) AS count
  FROM ${BUFFER_TABLES.receipts}
  GROUP BY ${RECEIPT_COLS.sourceApp}
`;

export interface SourceCounts {
  pending: number;
  failed: number;
  delivered: number;
}

export type CountsBySource = Record<SourceApp, SourceCounts>;

export function countsBySource(db: Database): CountsBySource {
  const result: CountsBySource = {
    'claude-code': { pending: 0, failed: 0, delivered: 0 },
    cursor: { pending: 0, failed: 0, delivered: 0 },
    codex: { pending: 0, failed: 0, delivered: 0 },
    'gemini-cli': { pending: 0, failed: 0, delivered: 0 },
  };
  const batchRows = db
    .query<{ source_app: string; status: string; count: number }, []>(COUNT_BATCHES_BY_SOURCE_SQL)
    .all();
  for (const row of batchRows) {
    const app = row.source_app as SourceApp;
    if (result[app] === undefined) continue;
    if (row.status === BATCH_STATUS.pending) result[app].pending = row.count;
    else if (row.status === BATCH_STATUS.failed) result[app].failed = row.count;
  }
  const receiptRows = db
    .query<{ source_app: string; count: number }, []>(COUNT_RECEIPTS_BY_SOURCE_SQL)
    .all();
  for (const row of receiptRows) {
    const app = row.source_app as SourceApp;
    if (result[app] === undefined) continue;
    result[app].delivered = row.count;
  }
  return result;
}
