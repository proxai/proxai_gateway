import type { Database, SQLQueryBindings } from 'bun:sqlite';

import {
  BATCH_COLS,
  BATCH_STATUS,
  BUFFER_TABLES,
  QUARANTINE_COLS,
  RECEIPT_COLS,
} from 'services/buffer/buffer.constants.ts';
import type { QuarantinedRecord, UploadedRecord } from 'cli/commands/logs/logs.types.ts';

export interface FailedBatchData {
  captureId: string;
  sourceApp: string;
  capturedAtUtc: string;
  sourcePath: string;
  sourcePathHash: string | null;
  attempts: number;
  lastError: string | null;
  watermarkKind: string;
  watermarkStart: number;
  watermarkEnd: number;
  watermarkTable: string | null;
  agentSchemaVersion: string | null;
  gatewayVersion: string | null;
  sourceInode: number | null;
  sizeBytes: number;
  body: Uint8Array;
  bodyFormat: string;
}

export type PendingBatchData = Omit<FailedBatchData, 'lastError'>;

export type CaptureLookupRaw =
  | { kind: 'uploaded'; record: UploadedRecord }
  | { kind: 'failed'; record: FailedBatchData }
  | { kind: 'pending'; record: PendingBatchData };

interface UploadedRow {
  capture_id: string;
  source_app: string;
  delivered_at: string;
  idempotent_on_server: number;
  user_prompt: string | null;
  user_prompt_added_at: string | null;
  source_path: string | null;
  source_path_hash: string;
  watermark_kind: string;
  watermark_start: number;
  watermark_end: number;
  watermark_table: string | null;
  agent_schema_version: string | null;
  gateway_version: string | null;
  captured_at_utc: string | null;
  shipped_bytes: number | null;
  attempts: number | null;
}

interface BatchRow {
  capture_id: string;
  source_app: string;
  captured_at_utc: string;
  source_path: string;
  source_path_hash: string | null;
  attempts: number;
  last_error: string | null;
  watermark_kind: string;
  watermark_start: number;
  watermark_end: number;
  watermark_table: string | null;
  agent_schema_version: string | null;
  gateway_version: string | null;
  source_inode: number | null;
  size_bytes: number;
  body: Uint8Array;
  body_format: string;
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

export interface LogsQueryOptions {
  limit: number;
  sourceApp?: string;
  sinceIso?: string;
}

function runAll<T>(db: Database, sql: string, params: SQLQueryBindings[]): T[] {
  return db.query<T, SQLQueryBindings[]>(sql).all(...params);
}

const UPLOADED_SELECT = `
  ${RECEIPT_COLS.captureId} AS capture_id,
  ${RECEIPT_COLS.sourceApp} AS source_app,
  ${RECEIPT_COLS.deliveredAt} AS delivered_at,
  ${RECEIPT_COLS.idempotentOnServer} AS idempotent_on_server,
  ${RECEIPT_COLS.userPrompt} AS user_prompt,
  ${RECEIPT_COLS.userPromptAddedAt} AS user_prompt_added_at,
  ${RECEIPT_COLS.sourcePath} AS source_path,
  ${RECEIPT_COLS.sourcePathHash} AS source_path_hash,
  ${RECEIPT_COLS.watermarkKind} AS watermark_kind,
  ${RECEIPT_COLS.watermarkStart} AS watermark_start,
  ${RECEIPT_COLS.watermarkEnd} AS watermark_end,
  ${RECEIPT_COLS.watermarkTable} AS watermark_table,
  ${RECEIPT_COLS.agentSchemaVersion} AS agent_schema_version,
  ${RECEIPT_COLS.gatewayVersion} AS gateway_version,
  ${RECEIPT_COLS.capturedAtUtc} AS captured_at_utc,
  ${RECEIPT_COLS.shippedBytes} AS shipped_bytes,
  ${RECEIPT_COLS.attempts} AS attempts
`;

const BATCH_SELECT = `
  ${BATCH_COLS.captureId} AS capture_id,
  ${BATCH_COLS.sourceApp} AS source_app,
  ${BATCH_COLS.capturedAtUtc} AS captured_at_utc,
  ${BATCH_COLS.sourcePath} AS source_path,
  ${BATCH_COLS.sourcePathHash} AS source_path_hash,
  ${BATCH_COLS.attempts} AS attempts,
  ${BATCH_COLS.lastError} AS last_error,
  ${BATCH_COLS.watermarkKind} AS watermark_kind,
  ${BATCH_COLS.watermarkStart} AS watermark_start,
  ${BATCH_COLS.watermarkEnd} AS watermark_end,
  ${BATCH_COLS.watermarkTable} AS watermark_table,
  ${BATCH_COLS.agentSchemaVersion} AS agent_schema_version,
  ${BATCH_COLS.gatewayVersion} AS gateway_version,
  ${BATCH_COLS.sourceInode} AS source_inode,
  LENGTH(${BATCH_COLS.body}) AS size_bytes,
  ${BATCH_COLS.body} AS body,
  ${BATCH_COLS.bodyFormat} AS body_format
`;

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
    SELECT ${UPLOADED_SELECT}
    FROM ${BUFFER_TABLES.receipts}
    ${where}
    ORDER BY ${RECEIPT_COLS.deliveredAt} DESC
    LIMIT ?
  `;
  return runAll<UploadedRow>(db, sql, params).map(rowToUploaded);
}

export function queryFailed(db: Database, opts: LogsQueryOptions): FailedBatchData[] {
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
    SELECT ${BATCH_SELECT}
    FROM ${BUFFER_TABLES.batches}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${BATCH_COLS.createdAt} DESC
    LIMIT ?
  `;
  return runAll<BatchRow>(db, sql, params).map(rowToFailed);
}

export function queryPending(db: Database, opts: LogsQueryOptions): PendingBatchData[] {
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
    SELECT ${BATCH_SELECT}
    FROM ${BUFFER_TABLES.batches}
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${BATCH_COLS.createdAt} DESC
    LIMIT ?
  `;
  return runAll<BatchRow>(db, sql, params).map(rowToPending);
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

export function queryByCaptureId(db: Database, prefix: string): CaptureLookupRaw | null {
  const like = `${prefix}%`;

  const uploadedSql = `
    SELECT ${UPLOADED_SELECT}
    FROM ${BUFFER_TABLES.receipts}
    WHERE ${RECEIPT_COLS.captureId} LIKE ?
    ORDER BY ${RECEIPT_COLS.deliveredAt} DESC
    LIMIT 1
  `;
  const uploaded = runAll<UploadedRow>(db, uploadedSql, [like]);
  if (uploaded.length > 0) {
    return { kind: 'uploaded', record: rowToUploaded(uploaded[0] as UploadedRow) };
  }

  const batchSql = `
    SELECT ${BATCH_SELECT}, ${BATCH_COLS.status} AS status
    FROM ${BUFFER_TABLES.batches}
    WHERE ${BATCH_COLS.captureId} LIKE ?
    ORDER BY ${BATCH_COLS.createdAt} DESC
    LIMIT 1
  `;
  const batches = runAll<BatchRow & { status: string }>(db, batchSql, [like]);
  const batch = batches[0];
  if (batch !== undefined) {
    if (batch.status === BATCH_STATUS.failed) {
      return { kind: 'failed', record: rowToFailed(batch) };
    }
    return { kind: 'pending', record: rowToPending(batch) };
  }

  return null;
}

function rowToUploaded(row: UploadedRow): UploadedRecord {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    deliveredAt: row.delivered_at,
    idempotentOnServer: row.idempotent_on_server !== 0,
    userPrompt: row.user_prompt,
    userPromptAddedAt: row.user_prompt_added_at,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    watermarkKind: row.watermark_kind,
    watermarkStart: row.watermark_start,
    watermarkEnd: row.watermark_end,
    watermarkTable: row.watermark_table,
    agentSchemaVersion: row.agent_schema_version,
    gatewayVersion: row.gateway_version,
    capturedAtUtc: row.captured_at_utc,
    shippedBytes: row.shipped_bytes,
    attempts: row.attempts,
  };
}

function rowToFailed(row: BatchRow): FailedBatchData {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    capturedAtUtc: row.captured_at_utc,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    attempts: row.attempts,
    lastError: row.last_error,
    watermarkKind: row.watermark_kind,
    watermarkStart: row.watermark_start,
    watermarkEnd: row.watermark_end,
    watermarkTable: row.watermark_table,
    agentSchemaVersion: row.agent_schema_version,
    gatewayVersion: row.gateway_version,
    sourceInode: row.source_inode,
    sizeBytes: row.size_bytes,
    body: row.body,
    bodyFormat: row.body_format,
  };
}

function rowToPending(row: BatchRow): PendingBatchData {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app,
    capturedAtUtc: row.captured_at_utc,
    sourcePath: row.source_path,
    sourcePathHash: row.source_path_hash,
    attempts: row.attempts,
    watermarkKind: row.watermark_kind,
    watermarkStart: row.watermark_start,
    watermarkEnd: row.watermark_end,
    watermarkTable: row.watermark_table,
    agentSchemaVersion: row.agent_schema_version,
    gatewayVersion: row.gateway_version,
    sourceInode: row.source_inode,
    sizeBytes: row.size_bytes,
    body: row.body,
    bodyFormat: row.body_format,
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
