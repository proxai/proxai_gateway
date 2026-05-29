import type { Database, SQLQueryBindings } from 'bun:sqlite';

import {
  BATCH_COLS,
  BATCH_STATUS,
  BUFFER_TABLES,
  QUARANTINE_COLS,
  RECEIPT_COLS,
} from 'services/buffer/buffer.constants.ts';
import type {
  FailedRecord,
  PendingRecord,
  QuarantinedRecord,
  UploadedRecord,
} from 'cli/commands/logs/logs.types.ts';

interface UploadedRow {
  capture_id: string;
  source_app: string;
  delivered_at: string;
  watermark_kind: string;
  source_path_hash: string;
  idempotent_on_server: number;
  source_path: string | null;
}

interface FailedRow {
  capture_id: string;
  source_app: string;
  captured_at_utc: string;
  source_path: string;
  source_path_hash: string | null;
  attempts: number;
  last_error: string | null;
}

interface QuarantinedRow {
  id: number;
  source_app: string;
  source_path: string;
  source_path_hash: string | null;
  redacted_size_bytes: number;
  reason: string;
  quarantined_at_utc: string;
}

interface PendingRow {
  capture_id: string;
  source_app: string;
  captured_at_utc: string;
  source_path: string;
  source_path_hash: string | null;
  attempts: number;
}

export interface LogsQueryOptions {
  limit: number;
  sourceApp?: string;
  sinceIso?: string;
}

function runAll<T>(db: Database, sql: string, params: SQLQueryBindings[]): T[] {
  return db.query<T, SQLQueryBindings[]>(sql).all(...params);
}

export function queryUploaded(db: Database, opts: LogsQueryOptions): UploadedRecord[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (opts.sourceApp !== undefined) {
    conditions.push(`${RECEIPT_COLS.sourceApp} = ?`);
    params.push(opts.sourceApp);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push(`${RECEIPT_COLS.deliveredAt} >= ?`);
    params.push(opts.sinceIso);
  }
  params.push(opts.limit);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      ${RECEIPT_COLS.captureId} AS capture_id,
      ${RECEIPT_COLS.sourceApp} AS source_app,
      ${RECEIPT_COLS.deliveredAt} AS delivered_at,
      ${RECEIPT_COLS.watermarkKind} AS watermark_kind,
      ${RECEIPT_COLS.sourcePathHash} AS source_path_hash,
      ${RECEIPT_COLS.idempotentOnServer} AS idempotent_on_server,
      ${RECEIPT_COLS.sourcePath} AS source_path
    FROM ${BUFFER_TABLES.receipts}
    ${where}
    ORDER BY ${RECEIPT_COLS.deliveredAt} DESC
    LIMIT ?
  `;
  return runAll<UploadedRow>(db, sql, params).map(rowToUploaded);
}

export function queryFailed(db: Database, opts: LogsQueryOptions): FailedRecord[] {
  const conditions: string[] = [`${BATCH_COLS.status} = '${BATCH_STATUS.failed}'`];
  const params: SQLQueryBindings[] = [];

  if (opts.sourceApp !== undefined) {
    conditions.push(`${BATCH_COLS.sourceApp} = ?`);
    params.push(opts.sourceApp);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push(`${BATCH_COLS.capturedAtUtc} >= ?`);
    params.push(opts.sinceIso);
  }
  params.push(opts.limit);

  const sql = `
    SELECT
      ${BATCH_COLS.captureId} AS capture_id,
      ${BATCH_COLS.sourceApp} AS source_app,
      ${BATCH_COLS.capturedAtUtc} AS captured_at_utc,
      ${BATCH_COLS.sourcePath} AS source_path,
      ${BATCH_COLS.sourcePathHash} AS source_path_hash,
      ${BATCH_COLS.attempts} AS attempts,
      ${BATCH_COLS.lastError} AS last_error
    FROM ${BUFFER_TABLES.batches}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${BATCH_COLS.createdAt} DESC
    LIMIT ?
  `;
  return runAll<FailedRow>(db, sql, params).map(rowToFailed);
}

export function queryQuarantined(db: Database, opts: LogsQueryOptions): QuarantinedRecord[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (opts.sourceApp !== undefined) {
    conditions.push(`${QUARANTINE_COLS.sourceApp} = ?`);
    params.push(opts.sourceApp);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push(`${QUARANTINE_COLS.quarantinedAtUtc} >= ?`);
    params.push(opts.sinceIso);
  }
  params.push(opts.limit);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      ${QUARANTINE_COLS.id} AS id,
      ${QUARANTINE_COLS.sourceApp} AS source_app,
      ${QUARANTINE_COLS.sourcePath} AS source_path,
      ${QUARANTINE_COLS.sourcePathHash} AS source_path_hash,
      ${QUARANTINE_COLS.redactedSizeBytes} AS redacted_size_bytes,
      ${QUARANTINE_COLS.reason} AS reason,
      ${QUARANTINE_COLS.quarantinedAtUtc} AS quarantined_at_utc
    FROM ${BUFFER_TABLES.quarantined}
    ${where}
    ORDER BY ${QUARANTINE_COLS.quarantinedAtUtc} DESC
    LIMIT ?
  `;
  return runAll<QuarantinedRow>(db, sql, params).map(rowToQuarantined);
}

export function queryPending(db: Database, opts: LogsQueryOptions): PendingRecord[] {
  const conditions: string[] = [`${BATCH_COLS.status} = '${BATCH_STATUS.pending}'`];
  const params: SQLQueryBindings[] = [];

  if (opts.sourceApp !== undefined) {
    conditions.push(`${BATCH_COLS.sourceApp} = ?`);
    params.push(opts.sourceApp);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push(`${BATCH_COLS.capturedAtUtc} >= ?`);
    params.push(opts.sinceIso);
  }
  params.push(opts.limit);

  const sql = `
    SELECT
      ${BATCH_COLS.captureId} AS capture_id,
      ${BATCH_COLS.sourceApp} AS source_app,
      ${BATCH_COLS.capturedAtUtc} AS captured_at_utc,
      ${BATCH_COLS.sourcePath} AS source_path,
      ${BATCH_COLS.sourcePathHash} AS source_path_hash,
      ${BATCH_COLS.attempts} AS attempts
    FROM ${BUFFER_TABLES.batches}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${BATCH_COLS.createdAt} DESC
    LIMIT ?
  `;
  return runAll<PendingRow>(db, sql, params).map(rowToPending);
}

function rowToUploaded(row: UploadedRow): UploadedRecord {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    deliveredAt: row.delivered_at,
    watermarkKind: row.watermark_kind,
    sourcePathHash: row.source_path_hash,
    idempotentOnServer: row.idempotent_on_server !== 0,
    sourcePath: row.source_path,
  };
}

function rowToFailed(row: FailedRow): FailedRecord {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    capturedAtUtc: row.captured_at_utc,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

function rowToQuarantined(row: QuarantinedRow): QuarantinedRecord {
  return {
    id: row.id,
    sourceApp: row.source_app,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    redactedSizeBytes: row.redacted_size_bytes,
    reason: row.reason,
    quarantinedAtUtc: row.quarantined_at_utc,
  };
}

function rowToPending(row: PendingRow): PendingRecord {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    capturedAtUtc: row.captured_at_utc,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    attempts: row.attempts,
  };
}
