import { Database } from 'bun:sqlite';

import { BATCH_COLS, BATCH_STATUS, BUFFER_TABLES } from 'services/buffer/buffer.constants.ts';

export interface DoctorBufferStats {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly failedCount: number;
  readonly quarantinedCount: number;
  readonly receiptCount: number;
  readonly lastPruneAt: string | null;
  readonly lastSuccessAt: string | null;
}

export interface DoctorDaemonState {
  readonly captureLastCycleAt: string | null;
  readonly drainLastCycleAt: string | null;
  readonly lastConsecutiveRetriableBreak: boolean | null;
  readonly lastUploadError: string | null;
}

export interface DoctorRecentEvents {
  readonly authUnconfirmedCount: number;
  readonly rateLimitedCount: number;
  readonly retriableCount: number;
  readonly fatalValidationErrorCount: number;
  readonly autoUpgradeEvents: readonly string[];
  readonly failedBatchLastErrors: readonly string[];
}

export interface RegressionLoop {
  readonly sourcePathHash: string;
  readonly countInLastHour: number;
}

export interface DoctorResyncStats {
  readonly totalCount: number;
  readonly regressionLoops: readonly RegressionLoop[];
}

const BUFFER_STATS_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN ${BATCH_COLS.status} = '${BATCH_STATUS.pending}' THEN 1 ELSE 0 END), 0) AS pending_count,
    COALESCE(SUM(CASE WHEN ${BATCH_COLS.status} = '${BATCH_STATUS.pending}' THEN LENGTH(${BATCH_COLS.body}) ELSE 0 END), 0) AS pending_bytes,
    COALESCE(SUM(CASE WHEN ${BATCH_COLS.status} = '${BATCH_STATUS.failed}' AND (?1 IS NULL OR ${BATCH_COLS.failedAt} > ?1) THEN 1 ELSE 0 END), 0) AS failed_count
  FROM ${BUFFER_TABLES.batches}
`;

const QUARANTINE_COUNT_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.quarantined}`;

const RECEIPT_COUNT_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.receipts}`;

const LAST_PRUNE_SQL = `SELECT value FROM ${BUFFER_TABLES.metadata} WHERE key = 'last_prune_at' LIMIT 1`;

const LAST_SUCCESS_SQL = `SELECT value FROM ${BUFFER_TABLES.metadata} WHERE key = 'upload_last_success_at' LIMIT 1`;

const DAEMON_STATE_SQL = `
  SELECT
    last_cycle_completed_at,
    last_drain_attempted,
    last_consecutive_retriable_break,
    last_upload_error
  FROM ${BUFFER_TABLES.daemonState}
  WHERE id = 1
`;

const CAPTURE_LAST_CYCLE_SQL = `SELECT value FROM ${BUFFER_TABLES.metadata} WHERE key = 'capture_last_cycle_at' LIMIT 1`;

const DRAIN_LAST_CYCLE_SQL = `SELECT value FROM ${BUFFER_TABLES.metadata} WHERE key = 'drain_last_cycle_at' LIMIT 1`;

const FAILED_BATCH_ERRORS_SQL = `
  SELECT ${BATCH_COLS.lastError} AS last_error
  FROM ${BUFFER_TABLES.batches}
  WHERE ${BATCH_COLS.status} = '${BATCH_STATUS.failed}'
    AND ${BATCH_COLS.lastError} IS NOT NULL
    AND (?1 IS NULL OR ${BATCH_COLS.failedAt} > ?1)
  ORDER BY ${BATCH_COLS.failedAt} DESC
  LIMIT 10
`;

const RESYNC_COUNT_SQL = `
  SELECT COUNT(*) AS count FROM resync_events
`;

const REGRESSION_LOOPS_SQL = `
  SELECT source_path_hash, COUNT(*) AS cnt
  FROM resync_events
  WHERE recovered_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
  GROUP BY source_path_hash
  HAVING cnt > 3
  ORDER BY cnt DESC
  LIMIT 20
`;

interface BatchStatsRow {
  pending_count: number;
  pending_bytes: number;
  failed_count: number;
}

interface SingleCountRow {
  count: number;
}

interface MetaValueRow {
  value: string;
}

interface DaemonStateRow {
  last_cycle_completed_at: string | null;
  last_drain_attempted: number | null;
  last_consecutive_retriable_break: number | null;
  last_upload_error: string | null;
}

interface FailedErrorRow {
  last_error: string | null;
}

interface RegressionRow {
  source_path_hash: string;
  cnt: number;
}

export function queryDoctorBufferStats(db: Database): DoctorBufferStats {
  const successRow = db.query<MetaValueRow, []>(LAST_SUCCESS_SQL).get();
  const lastSuccessAt = successRow?.value ?? null;

  const batchRow = db
    .query<BatchStatsRow, [string | null]>(BUFFER_STATS_SQL)
    .get(lastSuccessAt) ?? {
    pending_count: 0,
    pending_bytes: 0,
    failed_count: 0,
  };

  const quarRow = db.query<SingleCountRow, []>(QUARANTINE_COUNT_SQL).get();
  const quarantinedCount = quarRow?.count ?? 0;

  const recRow = db.query<SingleCountRow, []>(RECEIPT_COUNT_SQL).get();
  const receiptCount = recRow?.count ?? 0;

  const pruneRow = db.query<MetaValueRow, []>(LAST_PRUNE_SQL).get();
  const lastPruneAt = pruneRow?.value ?? null;

  return {
    pendingCount: batchRow.pending_count,
    pendingBytes: batchRow.pending_bytes,
    failedCount: batchRow.failed_count,
    quarantinedCount,
    receiptCount,
    lastPruneAt,
    lastSuccessAt,
  };
}

export function queryDoctorDaemonState(db: Database): DoctorDaemonState {
  const stateRow = db.query<DaemonStateRow, []>(DAEMON_STATE_SQL).get();

  const captureRow = db.query<MetaValueRow, []>(CAPTURE_LAST_CYCLE_SQL).get();
  const captureLastCycleAt = captureRow?.value ?? null;

  const drainRow = db.query<MetaValueRow, []>(DRAIN_LAST_CYCLE_SQL).get();
  const drainLastCycleAt = drainRow?.value ?? null;

  let lastConsecutiveRetriableBreak: boolean | null = null;
  if (stateRow !== null && stateRow.last_consecutive_retriable_break !== null) {
    lastConsecutiveRetriableBreak = stateRow.last_consecutive_retriable_break !== 0;
  }

  return {
    captureLastCycleAt,
    drainLastCycleAt,
    lastConsecutiveRetriableBreak,
    lastUploadError: stateRow?.last_upload_error ?? null,
  };
}

export function queryDoctorRecentEvents(db: Database): DoctorRecentEvents {
  const successRow = db.query<MetaValueRow, []>(LAST_SUCCESS_SQL).get();
  const lastSuccessAt = successRow?.value ?? null;
  const errorRows = db
    .query<FailedErrorRow, [string | null]>(FAILED_BATCH_ERRORS_SQL)
    .all(lastSuccessAt);
  const failedBatchLastErrors: string[] = [];
  let authUnconfirmedCount = 0;
  let rateLimitedCount = 0;
  let retriableCount = 0;
  let fatalValidationErrorCount = 0;
  const autoUpgradeEvents: string[] = [];

  for (const row of errorRows) {
    const err = row.last_error;
    if (err === null || err.length === 0) continue;
    failedBatchLastErrors.push(err);

    const lower = err.toLowerCase();
    if (lower.includes('auth_unconfirmed') || lower.includes('auth unconfirmed')) {
      authUnconfirmedCount++;
    } else if (lower.includes('rate') && lower.includes('limit')) {
      rateLimitedCount++;
    } else if (lower.includes('validationerror') || lower.includes('validation error')) {
      fatalValidationErrorCount++;
    } else if (lower.includes('retriable')) {
      retriableCount++;
    } else if (lower.includes('auto_upgrade') || lower.includes('upgrade')) {
      autoUpgradeEvents.push(err);
    }
  }

  return {
    authUnconfirmedCount,
    rateLimitedCount,
    retriableCount,
    fatalValidationErrorCount,
    autoUpgradeEvents,
    failedBatchLastErrors,
  };
}

export function queryDoctorResyncStats(db: Database): DoctorResyncStats {
  try {
    const countRow = db.query<SingleCountRow, []>(RESYNC_COUNT_SQL).get();
    const totalCount = countRow?.count ?? 0;

    const loopRows = db.query<RegressionRow, []>(REGRESSION_LOOPS_SQL).all();
    const regressionLoops: RegressionLoop[] = loopRows.map((row) => ({
      sourcePathHash: row.source_path_hash,
      countInLastHour: row.cnt,
    }));

    return { totalCount, regressionLoops };
  } catch {
    return { totalCount: 0, regressionLoops: [] };
  }
}

export function tableExists(db: Database, tableName: string): boolean {
  try {
    const row = db
      .query<
        SingleCountRow,
        [string]
      >(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName);
    return (row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

export function checkReceiptsTableReadable(db: Database): boolean {
  try {
    db.query<SingleCountRow, []>(RECEIPT_COUNT_SQL).get();
    return true;
  } catch {
    return false;
  }
}

export interface DoctorAllQueries {
  readonly bufferStats: DoctorBufferStats;
  readonly daemonState: DoctorDaemonState;
  readonly recentEvents: DoctorRecentEvents;
  readonly resyncStats: DoctorResyncStats;
  readonly dbReadable: boolean;
  readonly receiptsTableReadable: boolean;
}

const EMPTY_BUFFER_STATS: DoctorBufferStats = {
  pendingCount: 0,
  pendingBytes: 0,
  failedCount: 0,
  quarantinedCount: 0,
  receiptCount: 0,
  lastPruneAt: null,
  lastSuccessAt: null,
};

const EMPTY_DAEMON_STATE: DoctorDaemonState = {
  captureLastCycleAt: null,
  drainLastCycleAt: null,
  lastConsecutiveRetriableBreak: null,
  lastUploadError: null,
};

const EMPTY_RECENT_EVENTS: DoctorRecentEvents = {
  authUnconfirmedCount: 0,
  rateLimitedCount: 0,
  retriableCount: 0,
  fatalValidationErrorCount: 0,
  autoUpgradeEvents: [],
  failedBatchLastErrors: [],
};

const EMPTY_RESYNC_STATS: DoctorResyncStats = {
  totalCount: 0,
  regressionLoops: [],
};

export function queryAllDoctorData(bufferDbPath: string): DoctorAllQueries {
  let db: Database | null = null;
  try {
    db = new Database(bufferDbPath, { readonly: true });
  } catch {
    return {
      bufferStats: EMPTY_BUFFER_STATS,
      daemonState: EMPTY_DAEMON_STATE,
      recentEvents: EMPTY_RECENT_EVENTS,
      resyncStats: EMPTY_RESYNC_STATS,
      dbReadable: false,
      receiptsTableReadable: false,
    };
  }

  let bufferStats: DoctorBufferStats = EMPTY_BUFFER_STATS;
  let daemonState: DoctorDaemonState = EMPTY_DAEMON_STATE;
  let recentEvents: DoctorRecentEvents = EMPTY_RECENT_EVENTS;
  let resyncStats: DoctorResyncStats = EMPTY_RESYNC_STATS;
  const dbReadable = true;
  let receiptsTableReadable = false;

  try {
    bufferStats = queryDoctorBufferStats(db);
    receiptsTableReadable = true;
  } catch {
    receiptsTableReadable = checkReceiptsTableReadable(db);
  }
  try {
    daemonState = queryDoctorDaemonState(db);
  } catch {}
  try {
    recentEvents = queryDoctorRecentEvents(db);
  } catch {}
  try {
    resyncStats = queryDoctorResyncStats(db);
  } catch {}

  try {
    db.close();
  } catch {}

  return {
    bufferStats,
    daemonState,
    recentEvents,
    resyncStats,
    dbReadable,
    receiptsTableReadable,
  };
}
