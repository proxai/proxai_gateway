import type { BatchStatus } from 'services/buffer/buffer.types.ts';

export const VALID_BATCH_STATUSES: readonly BatchStatus[] = ['pending', 'done', 'failed'];

export const NO_INODE_SENTINEL = 0;
export const NO_TABLE_SENTINEL = '';

export const BUFFER_TABLES = {
  batches: 'upload_batches',
  cursors: 'source_cursors',
} as const;

export const BATCH_COLS = {
  captureId: 'capture_id',
  sourceApp: 'source_app',
  sourceKind: 'source_kind',
  sourcePath: 'source_path',
  sourcePathHash: 'source_path_hash',
  sourceInode: 'source_inode',
  watermarkKind: 'watermark_kind',
  watermarkStart: 'watermark_start',
  watermarkEnd: 'watermark_end',
  watermarkTable: 'watermark_table',
  agentSchemaVersion: 'agent_schema_version',
  gatewayVersion: 'gateway_version',
  capturedAtUtc: 'captured_at_utc',
  bodyFormat: 'body_format',
  bodyCompression: 'body_compression',
  body: 'body',
  status: 'status',
  attempts: 'attempts',
  createdAt: 'created_at',
  lastError: 'last_error',
} as const;

export const CURSOR_COLS = {
  sourceApp: 'source_app',
  sourcePathHash: 'source_path_hash',
  sourcePath: 'source_path',
  sourceInode: 'source_inode',
  watermarkTable: 'watermark_table',
  watermarkEnd: 'watermark_end',
  lastPolledAt: 'last_polled_at',
  consecutiveErrors: 'consecutive_errors',
} as const;

export const BUFFER_INDEXES = {
  batchesStatusCreated: 'idx_upload_batches_status_created',
  batchesPathHash: 'idx_upload_batches_path_hash',
} as const;

export const BATCH_STATUS = {
  pending: 'pending',
  done: 'done',
  failed: 'failed',
} as const;

export const BATCH_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.batches} (
    ${BATCH_COLS.captureId} TEXT PRIMARY KEY NOT NULL,
    ${BATCH_COLS.sourceApp} TEXT NOT NULL,
    ${BATCH_COLS.sourceKind} TEXT NOT NULL,
    ${BATCH_COLS.sourcePath} TEXT NOT NULL,
    ${BATCH_COLS.sourcePathHash} TEXT NOT NULL,
    ${BATCH_COLS.sourceInode} INTEGER,
    ${BATCH_COLS.watermarkKind} TEXT NOT NULL,
    ${BATCH_COLS.watermarkStart} INTEGER NOT NULL,
    ${BATCH_COLS.watermarkEnd} INTEGER NOT NULL,
    ${BATCH_COLS.watermarkTable} TEXT,
    ${BATCH_COLS.agentSchemaVersion} TEXT NOT NULL,
    ${BATCH_COLS.gatewayVersion} TEXT NOT NULL,
    ${BATCH_COLS.capturedAtUtc} TEXT NOT NULL,
    ${BATCH_COLS.bodyFormat} TEXT NOT NULL,
    ${BATCH_COLS.bodyCompression} TEXT NOT NULL,
    ${BATCH_COLS.body} BLOB NOT NULL,
    ${BATCH_COLS.status} TEXT NOT NULL DEFAULT '${BATCH_STATUS.pending}',
    ${BATCH_COLS.attempts} INTEGER NOT NULL DEFAULT 0,
    ${BATCH_COLS.createdAt} TEXT NOT NULL,
    ${BATCH_COLS.lastError} TEXT
  )
`;

export const BATCH_STATUS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.batchesStatusCreated}
    ON ${BUFFER_TABLES.batches} (${BATCH_COLS.status}, ${BATCH_COLS.createdAt})
`;

export const BATCH_PATH_HASH_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.batchesPathHash}
    ON ${BUFFER_TABLES.batches} (${BATCH_COLS.sourcePathHash})
`;

export const CURSOR_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.cursors} (
    ${CURSOR_COLS.sourceApp} TEXT NOT NULL,
    ${CURSOR_COLS.sourcePathHash} TEXT NOT NULL,
    ${CURSOR_COLS.sourcePath} TEXT NOT NULL,
    ${CURSOR_COLS.sourceInode} INTEGER NOT NULL DEFAULT ${NO_INODE_SENTINEL},
    ${CURSOR_COLS.watermarkTable} TEXT NOT NULL DEFAULT '${NO_TABLE_SENTINEL}',
    ${CURSOR_COLS.watermarkEnd} INTEGER NOT NULL DEFAULT 0,
    ${CURSOR_COLS.lastPolledAt} TEXT NOT NULL,
    ${CURSOR_COLS.consecutiveErrors} INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (
      ${CURSOR_COLS.sourceApp},
      ${CURSOR_COLS.sourcePathHash},
      ${CURSOR_COLS.sourceInode},
      ${CURSOR_COLS.watermarkTable}
    )
  )
`;
