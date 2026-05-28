import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';
import {
  BATCH_COLS,
  BATCH_STATUS,
  BUFFER_TABLES,
  RECEIPT_COLS,
  RESYNC_EVENT_COLS,
} from 'services/buffer/buffer.constants.ts';
import { setLastPruneAt } from 'services/buffer/metadata.ts';
import { pruneQuarantinedOlderThan } from 'services/buffer/quarantine.ts';

const MS_PER_DAY = 86_400_000;

const RECEIPT_BYTES_PER_ROW = 200;

const COUNT_OLD_RECEIPTS_SQL = `
  SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.deliveredAt} < ?
`;

const DELETE_OLD_RECEIPTS_SQL = `
  DELETE FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.deliveredAt} < ?
`;

const DELETE_OLD_RESYNC_EVENTS_SQL = `
  DELETE FROM ${BUFFER_TABLES.resyncEvents}
  WHERE ${RESYNC_EVENT_COLS.recoveredAt} < ?
`;

const SUM_OLD_FAILED_BYTES_SQL = `
  SELECT
    COUNT(*) AS count,
    COALESCE(SUM(LENGTH(${BATCH_COLS.body})), 0) AS bytes
  FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.failed}'
    AND ${BATCH_COLS.createdAt} < ?
`;

const DELETE_OLD_FAILED_SQL = `
  DELETE FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.failed}'
    AND ${BATCH_COLS.createdAt} < ?
`;

export interface PruneInput {
  db: Database;
  receiptRetentionDays: number;
  failedRetentionDays: number;
  now?: Date;
  logger?: MinimalLogger;
}

export interface PruneResult {
  receiptsDeleted: number;
  failedBatchesDeleted: number;
  quarantinedDeleted: number;
  resyncEventsDeleted: number;
  receiptBytesFreed: number;
  failedBytesFreed: number;
}

export function pruneBuffer(input: PruneInput): PruneResult {
  const { db, receiptRetentionDays, failedRetentionDays } = input;
  const log = input.logger;
  const now = input.now ?? new Date();

  const receiptCutoff = new Date(now.getTime() - receiptRetentionDays * MS_PER_DAY).toISOString();
  const failedCutoff = new Date(now.getTime() - failedRetentionDays * MS_PER_DAY).toISOString();

  let receiptsDeleted = 0;
  let failedBatchesDeleted = 0;
  let failedBytesFreed = 0;
  let quarantinedDeleted = 0;
  let resyncEventsDeleted = 0;

  const tx = db.transaction(() => {
    const receiptCountRow = db
      .query<{ count: number }, [string]>(COUNT_OLD_RECEIPTS_SQL)
      .get(receiptCutoff);
    receiptsDeleted = receiptCountRow?.count ?? 0;
    if (receiptsDeleted > 0) {
      db.query(DELETE_OLD_RECEIPTS_SQL).run(receiptCutoff);
    }

    const failedRow = db
      .query<{ count: number; bytes: number }, [string]>(SUM_OLD_FAILED_BYTES_SQL)
      .get(failedCutoff);
    failedBatchesDeleted = failedRow?.count ?? 0;
    failedBytesFreed = failedRow?.bytes ?? 0;
    if (failedBatchesDeleted > 0) {
      db.query(DELETE_OLD_FAILED_SQL).run(failedCutoff);
    }

    quarantinedDeleted = pruneQuarantinedOlderThan(db, failedCutoff);

    const resyncResult = db.query(DELETE_OLD_RESYNC_EVENTS_SQL).run(receiptCutoff);
    resyncEventsDeleted = Number(resyncResult.changes ?? 0);

    setLastPruneAt(db, now.toISOString());
  });
  tx();

  const receiptBytesFreed = receiptsDeleted * RECEIPT_BYTES_PER_ROW;
  const result: PruneResult = {
    receiptsDeleted,
    failedBatchesDeleted,
    quarantinedDeleted,
    resyncEventsDeleted,
    receiptBytesFreed,
    failedBytesFreed,
  };

  log?.info(
    {
      event: 'buffer.prune',
      receipts_deleted: receiptsDeleted,
      receipt_bytes_freed: receiptBytesFreed,
      failed_batches_deleted: failedBatchesDeleted,
      failed_bytes_freed: failedBytesFreed,
      quarantined_deleted: quarantinedDeleted,
      resync_events_deleted: resyncEventsDeleted,
      receipt_cutoff: receiptCutoff,
      failed_cutoff: failedCutoff,
    },
    'buffer prune complete',
  );

  return result;
}
