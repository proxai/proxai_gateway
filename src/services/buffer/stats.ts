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

export interface UploadTotals {
  batches: number;
  bytes: number;
}

export interface UploadTotalsBySource {
  [app: string]: UploadTotals;
}

export interface DerivedUploadStats {
  totalBatchesUploaded: number;
  totalBytesUploaded: number;
  bySource: UploadTotalsBySource;
  lastSuccessAt: string | null;
  idempotentResends: number;
}

export interface DerivedCaptureStats {
  capturedBytes: number;
}

export interface ResyncSummary {
  total: number;
  totalSkippedUnits: number;
}

const COUNT_RECEIPTS_UPLOADED_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.receipts}`;

const SUM_SHIPPED_BYTES_SQL = `
  SELECT COALESCE(SUM(${RECEIPT_COLS.shippedBytes}), 0) AS total
  FROM ${BUFFER_TABLES.receipts}
`;

const MAX_DELIVERED_AT_SQL = `
  SELECT MAX(${RECEIPT_COLS.deliveredAt}) AS last_at FROM ${BUFFER_TABLES.receipts}
`;

const COUNT_IDEMPOTENT_SQL = `
  SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.idempotentOnServer} = 1
`;

const UPLOAD_TOTALS_BY_SOURCE_SQL = `
  SELECT
    ${RECEIPT_COLS.sourceApp} AS source_app,
    COUNT(*) AS batches,
    COALESCE(SUM(${RECEIPT_COLS.shippedBytes}), 0) AS bytes
  FROM ${BUFFER_TABLES.receipts}
  GROUP BY ${RECEIPT_COLS.sourceApp}
`;

export function derivedUploadStats(db: Database): DerivedUploadStats {
  const countRow = db.query<{ count: number }, []>(COUNT_RECEIPTS_UPLOADED_SQL).get();
  const totalBatchesUploaded = countRow?.count ?? 0;

  const bytesRow = db.query<{ total: number }, []>(SUM_SHIPPED_BYTES_SQL).get();
  const totalBytesUploaded = bytesRow?.total ?? 0;

  const lastAtRow = db.query<{ last_at: string | null }, []>(MAX_DELIVERED_AT_SQL).get();
  const lastSuccessAt = lastAtRow?.last_at ?? null;

  const idempotentRow = db.query<{ count: number }, []>(COUNT_IDEMPOTENT_SQL).get();
  const idempotentResends = idempotentRow?.count ?? 0;

  const sourceRows = db
    .query<{ source_app: string; batches: number; bytes: number }, []>(UPLOAD_TOTALS_BY_SOURCE_SQL)
    .all();
  const bySource: UploadTotalsBySource = {};
  for (const row of sourceRows) {
    bySource[row.source_app] = { batches: row.batches, bytes: row.bytes };
  }

  return { totalBatchesUploaded, totalBytesUploaded, bySource, lastSuccessAt, idempotentResends };
}

const SUM_PENDING_AND_FAILED_BODY_SQL = `
  SELECT COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS total
  FROM ${BUFFER_TABLES.batches}
`;

export function derivedCapturedBytes(db: Database, uploadedBytes: number): number {
  const row = db.query<{ total: number }, []>(SUM_PENDING_AND_FAILED_BODY_SQL).get();
  const inFlightBytes = row?.total ?? 0;
  return uploadedBytes + inFlightBytes;
}

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

const STATS_BATCHES_BY_SOURCE_SQL = `
  SELECT ${BATCH_COLS.sourceApp} AS source_app,
         ${BATCH_COLS.status} AS status,
         COUNT(*) AS count,
         COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS bytes
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
  pendingBytes: number;
  failed: number;
  failedBytes: number;
  delivered: number;
}

export type CountsBySource = Record<SourceApp, SourceCounts>;

function emptySourceCounts(): SourceCounts {
  return { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 };
}

export function countsBySource(db: Database): CountsBySource {
  const result: CountsBySource = {
    'claude-code': emptySourceCounts(),
    cursor: emptySourceCounts(),
    codex: emptySourceCounts(),
    'claude-desktop': emptySourceCounts(),
  };
  const batchRows = db
    .query<
      { source_app: string; status: string; count: number; bytes: number },
      []
    >(STATS_BATCHES_BY_SOURCE_SQL)
    .all();
  for (const row of batchRows) {
    const app = row.source_app as SourceApp;
    if (result[app] === undefined) continue;
    if (row.status === BATCH_STATUS.pending) {
      result[app].pending = row.count;
      result[app].pendingBytes = row.bytes;
    } else if (row.status === BATCH_STATUS.failed) {
      result[app].failed = row.count;
      result[app].failedBytes = row.bytes;
    }
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
