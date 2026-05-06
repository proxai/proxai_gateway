import type { Database } from 'bun:sqlite';

import { nowIsoUtc } from 'core/utils';
import { BATCH_COLS, BATCH_STATUS, BUFFER_TABLES } from 'services/buffer/buffer.constants.ts';
import type { BatchStatus, NewBatch, StoredBatch } from 'services/buffer/buffer.types.ts';
import { insertReceipt } from 'services/buffer/receipts.ts';
import type {
  BodyCompression,
  BodyFormat,
  SourceApp,
  SourceKind,
  WatermarkKind,
} from 'services/contract';

interface BatchRow {
  capture_id: string;
  source_app: string;
  source_kind: string;
  source_path: string;
  source_path_hash: string;
  source_inode: number | null;
  watermark_kind: string;
  watermark_start: number;
  watermark_end: number;
  watermark_table: string | null;
  agent_schema_version: string;
  gateway_version: string;
  captured_at_utc: string;
  body_format: string;
  body_compression: string;
  body: Uint8Array;
  status: string;
  attempts: number;
  created_at: string;
  last_error: string | null;
}

const INSERT_BATCH_SQL = `
  INSERT INTO ${BUFFER_TABLES.batches} (
    ${BATCH_COLS.captureId},
    ${BATCH_COLS.sourceApp},
    ${BATCH_COLS.sourceKind},
    ${BATCH_COLS.sourcePath},
    ${BATCH_COLS.sourcePathHash},
    ${BATCH_COLS.sourceInode},
    ${BATCH_COLS.watermarkKind},
    ${BATCH_COLS.watermarkStart},
    ${BATCH_COLS.watermarkEnd},
    ${BATCH_COLS.watermarkTable},
    ${BATCH_COLS.agentSchemaVersion},
    ${BATCH_COLS.gatewayVersion},
    ${BATCH_COLS.capturedAtUtc},
    ${BATCH_COLS.bodyFormat},
    ${BATCH_COLS.bodyCompression},
    ${BATCH_COLS.body},
    ${BATCH_COLS.status},
    ${BATCH_COLS.attempts},
    ${BATCH_COLS.createdAt}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${BATCH_STATUS.pending}', 0, ?)
`;

const GET_BATCH_SQL = `SELECT * FROM ${BUFFER_TABLES.batches} WHERE ${BATCH_COLS.captureId} = ?`;

const NEXT_PENDING_SQL = `
  SELECT * FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.pending}'
  ORDER BY ${BATCH_COLS.createdAt} ASC, ${BATCH_COLS.captureId} ASC
  LIMIT 1
`;

const DELETE_BATCH_SQL = `
  DELETE FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.captureId} = ?
`;

const MARK_FAILED_SQL = `
  UPDATE ${BUFFER_TABLES.batches}
  SET ${BATCH_COLS.status} = '${BATCH_STATUS.failed}',
      ${BATCH_COLS.lastError} = ?,
      ${BATCH_COLS.attempts} = ${BATCH_COLS.attempts} + 1
  WHERE ${BATCH_COLS.captureId} = ?
`;

const RECORD_RETRIABLE_SQL = `
  UPDATE ${BUFFER_TABLES.batches}
  SET ${BATCH_COLS.attempts} = ${BATCH_COLS.attempts} + 1,
      ${BATCH_COLS.lastError} = ?
  WHERE ${BATCH_COLS.captureId} = ?
`;

const DROP_OLDEST_PENDING_SQL = `
  DELETE FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.captureId} = (
    SELECT ${BATCH_COLS.captureId} FROM ${BUFFER_TABLES.batches}
    WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.pending}'
    ORDER BY ${BATCH_COLS.createdAt} ASC
    LIMIT 1
  )
  RETURNING ${BATCH_COLS.captureId}
`;

export function insertBatch(db: Database, batch: NewBatch): void {
  db.query(INSERT_BATCH_SQL).run(
    batch.captureId,
    batch.sourceApp,
    batch.sourceKind,
    batch.sourcePath,
    batch.sourcePathHash,
    batch.sourceInode,
    batch.watermarkKind,
    batch.watermarkStart,
    batch.watermarkEnd,
    batch.watermarkTable,
    batch.agentSchemaVersion,
    batch.gatewayVersion,
    batch.capturedAtUtc,
    batch.bodyFormat,
    batch.bodyCompression,
    batch.body,
    nowIsoUtc(),
  );
}

export function getBatch(db: Database, captureId: string): StoredBatch | null {
  const row = db.query<BatchRow, [string]>(GET_BATCH_SQL).get(captureId);
  return row === null ? null : rowToBatch(row);
}

export function nextPendingBatch(db: Database): StoredBatch | null {
  const row = db.query<BatchRow, []>(NEXT_PENDING_SQL).get();
  return row === null ? null : rowToBatch(row);
}

export interface MarkBatchDeliveredInput {
  idempotentOnServer: boolean;
  deliveredAt?: string;
}

export function markBatchDelivered(
  db: Database,
  batch: StoredBatch,
  input: MarkBatchDeliveredInput,
): void {
  const deliveredAt = input.deliveredAt ?? nowIsoUtc();
  const tx = db.transaction(() => {
    insertReceipt(db, {
      captureId: batch.captureId,
      sourceApp: batch.sourceApp,
      sourcePathHash: batch.sourcePathHash,
      watermarkKind: batch.watermarkKind,
      watermarkStart: batch.watermarkStart,
      watermarkEnd: batch.watermarkEnd,
      watermarkTable: batch.watermarkTable,
      deliveredAt,
      idempotentOnServer: input.idempotentOnServer,
    });
    db.query(DELETE_BATCH_SQL).run(batch.captureId);
  });
  tx();
}

export function markBatchFailed(db: Database, captureId: string, error: string): void {
  db.query(MARK_FAILED_SQL).run(error, captureId);
}

export function deleteBatch(db: Database, captureId: string): void {
  db.query(DELETE_BATCH_SQL).run(captureId);
}

export function recordRetriableFailure(db: Database, captureId: string, error: string): void {
  db.query(RECORD_RETRIABLE_SQL).run(error, captureId);
}

export function dropOldestPending(db: Database): string | null {
  const row = db.query<{ capture_id: string }, []>(DROP_OLDEST_PENDING_SQL).get();
  return row === null ? null : row.capture_id;
}

function rowToBatch(row: BatchRow): StoredBatch {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app as SourceApp,
    sourceKind: row.source_kind as SourceKind,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    sourceInode: row.source_inode,
    watermarkKind: row.watermark_kind as WatermarkKind,
    watermarkStart: row.watermark_start,
    watermarkEnd: row.watermark_end,
    watermarkTable: row.watermark_table,
    agentSchemaVersion: row.agent_schema_version,
    gatewayVersion: row.gateway_version,
    capturedAtUtc: row.captured_at_utc,
    bodyFormat: row.body_format as BodyFormat,
    bodyCompression: row.body_compression as BodyCompression,
    body: row.body,
    status: row.status as BatchStatus,
    attempts: row.attempts,
    createdAt: row.created_at,
    lastError: row.last_error,
  };
}
