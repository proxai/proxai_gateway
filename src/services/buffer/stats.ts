import type { Database } from 'bun:sqlite';

import { BATCH_COLS, BATCH_STATUS, BUFFER_TABLES } from 'services/buffer/buffer.constants.ts';
import type { BatchStatus, BufferCounts } from 'services/buffer/buffer.types.ts';

const TOTAL_PENDING_BYTES_SQL = `
  SELECT COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS total
  FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.pending}'
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

export function countByStatus(db: Database): BufferCounts {
  const rows = db.query<{ status: string; count: number }, []>(COUNT_BY_STATUS_SQL).all();
  const counts: BufferCounts = { pending: 0, done: 0, failed: 0 };
  for (const row of rows) {
    counts[row.status as BatchStatus] = row.count;
  }
  return counts;
}
