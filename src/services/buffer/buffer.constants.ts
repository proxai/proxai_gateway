import type { BatchStatus } from 'services/buffer/buffer.types.ts';

export const VALID_BATCH_STATUSES: readonly BatchStatus[] = ['pending', 'failed'];

export const NO_INODE_SENTINEL = 0;
export const NO_TABLE_SENTINEL = '';

export const BUFFER_TABLES = {
  batches: 'upload_batches',
  cursors: 'source_cursors',
  receipts: 'upload_receipts',
  metadata: 'buffer_metadata',
  daemonState: 'daemon_state',
  quarantined: 'quarantined_records',
} as const;

export const METADATA_COLS = {
  key: 'key',
  value: 'value',
} as const;

export const METADATA_KEYS = {
  lastPruneAt: 'last_prune_at',
  lastVersionCheckAt: 'last_version_check_at',
  cyclesTotal: 'cycles_total',
  cyclesWithErrors: 'cycles_with_errors',
  cyclesTotalDurationMs: 'cycles_total_duration_ms',
  uploadTotalBatchesShipped: 'upload_total_batches_shipped',
  uploadTotalBytesShipped: 'upload_total_bytes_shipped',
  uploadLastSuccessAt: 'upload_last_success_at',
  uploadLastSuccessBatches: 'upload_last_success_batches',
  uploadLastSuccessBytes: 'upload_last_success_bytes',
  latestKnownVersion: 'latest_known_version',
  captureCyclesTotal: 'capture_cycles_total',
  captureCyclesWithErrors: 'capture_cycles_with_errors',
  captureLastCycleAt: 'capture_last_cycle_at',
  captureLastCycleDurationMs: 'capture_last_cycle_duration_ms',
  drainCyclesTotal: 'drain_cycles_total',
  drainCyclesWithErrors: 'drain_cycles_with_errors',
  drainLastCycleAt: 'drain_last_cycle_at',
  drainLastCycleDurationMs: 'drain_last_cycle_duration_ms',
  drainTotalBatchesShipped: 'drain_total_batches_shipped',
  drainTotalBytesShipped: 'drain_total_bytes_shipped',
} as const;

export function uploadBatchesShippedKey(sourceApp: string): string {
  return `upload_batches_shipped_by_source.${sourceApp}`;
}

export function uploadBytesShippedKey(sourceApp: string): string {
  return `upload_bytes_shipped_by_source.${sourceApp}`;
}

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
  lastSeenSizeBytes: 'last_seen_size_bytes',
  lastSeenPageCount: 'last_seen_page_count',
} as const;

export const RECEIPT_COLS = {
  captureId: 'capture_id',
  sourceApp: 'source_app',
  sourcePathHash: 'source_path_hash',
  watermarkKind: 'watermark_kind',
  watermarkStart: 'watermark_start',
  watermarkEnd: 'watermark_end',
  watermarkTable: 'watermark_table',
  deliveredAt: 'delivered_at',
  idempotentOnServer: 'idempotent_on_server',
} as const;

export const BUFFER_INDEXES = {
  batchesStatusCreated: 'idx_upload_batches_status_created',
  batchesPathHash: 'idx_upload_batches_path_hash',
  receiptsPathHash: 'idx_upload_receipts_path_hash',
  receiptsDeliveredAt: 'idx_upload_receipts_delivered_at',
  quarantinedSourceApp: 'idx_quarantined_records_source_app',
  quarantinedAt: 'idx_quarantined_records_quarantined_at',
} as const;

export const QUARANTINE_COLS = {
  id: 'id',
  sourceApp: 'source_app',
  sourcePath: 'source_path',
  sourcePathHash: 'source_path_hash',
  sourceInode: 'source_inode',
  watermarkTable: 'watermark_table',
  watermarkPosition: 'watermark_position',
  rowPk: 'row_pk',
  redactedSizeBytes: 'redacted_size_bytes',
  reason: 'reason',
  quarantinedAtUtc: 'quarantined_at_utc',
  gatewayVersion: 'gateway_version',
} as const;

export const BATCH_STATUS = {
  pending: 'pending',
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
    ${CURSOR_COLS.lastSeenSizeBytes} INTEGER,
    ${CURSOR_COLS.lastSeenPageCount} INTEGER,
    PRIMARY KEY (
      ${CURSOR_COLS.sourceApp},
      ${CURSOR_COLS.sourcePathHash},
      ${CURSOR_COLS.sourceInode},
      ${CURSOR_COLS.watermarkTable}
    )
  )
`;

export const CURSOR_ALTER_ADD_LAST_SEEN_SIZE_DDL = `
  ALTER TABLE ${BUFFER_TABLES.cursors}
    ADD COLUMN ${CURSOR_COLS.lastSeenSizeBytes} INTEGER
`;

export const CURSOR_ALTER_ADD_LAST_SEEN_PAGE_COUNT_DDL = `
  ALTER TABLE ${BUFFER_TABLES.cursors}
    ADD COLUMN ${CURSOR_COLS.lastSeenPageCount} INTEGER
`;

export const RECEIPT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.receipts} (
    ${RECEIPT_COLS.captureId} TEXT PRIMARY KEY NOT NULL,
    ${RECEIPT_COLS.sourceApp} TEXT NOT NULL,
    ${RECEIPT_COLS.sourcePathHash} TEXT NOT NULL,
    ${RECEIPT_COLS.watermarkKind} TEXT NOT NULL,
    ${RECEIPT_COLS.watermarkStart} INTEGER NOT NULL,
    ${RECEIPT_COLS.watermarkEnd} INTEGER NOT NULL,
    ${RECEIPT_COLS.watermarkTable} TEXT,
    ${RECEIPT_COLS.deliveredAt} TEXT NOT NULL,
    ${RECEIPT_COLS.idempotentOnServer} INTEGER NOT NULL DEFAULT 0
  )
`;

export const RECEIPT_PATH_HASH_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.receiptsPathHash}
    ON ${BUFFER_TABLES.receipts} (${RECEIPT_COLS.sourcePathHash})
`;

export const RECEIPT_DELIVERED_AT_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.receiptsDeliveredAt}
    ON ${BUFFER_TABLES.receipts} (${RECEIPT_COLS.deliveredAt})
`;

export const METADATA_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.metadata} (
    ${METADATA_COLS.key} TEXT PRIMARY KEY NOT NULL,
    ${METADATA_COLS.value} TEXT NOT NULL
  )
`;

export const QUARANTINE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.quarantined} (
    ${QUARANTINE_COLS.id} INTEGER PRIMARY KEY AUTOINCREMENT,
    ${QUARANTINE_COLS.sourceApp} TEXT NOT NULL,
    ${QUARANTINE_COLS.sourcePath} TEXT NOT NULL,
    ${QUARANTINE_COLS.sourcePathHash} TEXT NOT NULL,
    ${QUARANTINE_COLS.sourceInode} INTEGER,
    ${QUARANTINE_COLS.watermarkTable} TEXT,
    ${QUARANTINE_COLS.watermarkPosition} INTEGER NOT NULL,
    ${QUARANTINE_COLS.rowPk} TEXT,
    ${QUARANTINE_COLS.redactedSizeBytes} INTEGER NOT NULL,
    ${QUARANTINE_COLS.reason} TEXT NOT NULL,
    ${QUARANTINE_COLS.quarantinedAtUtc} TEXT NOT NULL,
    ${QUARANTINE_COLS.gatewayVersion} TEXT NOT NULL
  )
`;

export const QUARANTINE_SOURCE_APP_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.quarantinedSourceApp}
    ON ${BUFFER_TABLES.quarantined} (${QUARANTINE_COLS.sourceApp})
`;

export const QUARANTINE_AT_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS ${BUFFER_INDEXES.quarantinedAt}
    ON ${BUFFER_TABLES.quarantined} (${QUARANTINE_COLS.quarantinedAtUtc})
`;
