import type { Database } from 'bun:sqlite';

import { BUFFER_TABLES } from 'services/buffer/buffer.constants.ts';

export const DAEMON_STATE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${BUFFER_TABLES.daemonState} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_cycle_started_at TEXT,
    last_cycle_completed_at TEXT,
    last_cycle_duration_ms INTEGER,
    last_drain_attempted INTEGER,
    last_drain_accepted INTEGER,
    last_drain_retriable INTEGER,
    last_drain_fatal INTEGER,
    last_drain_recovered INTEGER,
    last_upload_error TEXT,
    last_consecutive_retriable_break INTEGER,
    last_source_captures TEXT
  )
`;

export interface SourceCycleResult {
  filesProcessed: number;
  capturedBatches: number;
  capturedBytes: number;
  errorsCount: number;
}

export interface DaemonStateSnapshot {
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastDrainAttempted: number | null;
  lastDrainAccepted: number | null;
  lastDrainRetriable: number | null;
  lastDrainFatal: number | null;
  lastDrainRecovered: number | null;
  lastUploadError: string | null;
  lastConsecutiveRetriableBreak: boolean | null;
  lastSourceCaptures: Record<string, SourceCycleResult>;
}

interface DaemonStateRow {
  last_cycle_started_at: string | null;
  last_cycle_completed_at: string | null;
  last_cycle_duration_ms: number | null;
  last_drain_attempted: number | null;
  last_drain_accepted: number | null;
  last_drain_retriable: number | null;
  last_drain_fatal: number | null;
  last_drain_recovered: number | null;
  last_upload_error: string | null;
  last_consecutive_retriable_break: number | null;
  last_source_captures: string | null;
}

const UPSERT_DAEMON_STATE_SQL = `
  INSERT INTO ${BUFFER_TABLES.daemonState} (
    id,
    last_cycle_started_at,
    last_cycle_completed_at,
    last_cycle_duration_ms,
    last_drain_attempted,
    last_drain_accepted,
    last_drain_retriable,
    last_drain_fatal,
    last_drain_recovered,
    last_upload_error,
    last_consecutive_retriable_break,
    last_source_captures
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_cycle_started_at = excluded.last_cycle_started_at,
    last_cycle_completed_at = excluded.last_cycle_completed_at,
    last_cycle_duration_ms = excluded.last_cycle_duration_ms,
    last_drain_attempted = excluded.last_drain_attempted,
    last_drain_accepted = excluded.last_drain_accepted,
    last_drain_retriable = excluded.last_drain_retriable,
    last_drain_fatal = excluded.last_drain_fatal,
    last_drain_recovered = excluded.last_drain_recovered,
    last_upload_error = excluded.last_upload_error,
    last_consecutive_retriable_break = excluded.last_consecutive_retriable_break,
    last_source_captures = excluded.last_source_captures
`;

const GET_DAEMON_STATE_SQL = `SELECT * FROM ${BUFFER_TABLES.daemonState} WHERE id = 1`;

export function setDaemonState(db: Database, snapshot: DaemonStateSnapshot): void {
  db.query(UPSERT_DAEMON_STATE_SQL).run(
    snapshot.lastCycleStartedAt,
    snapshot.lastCycleCompletedAt,
    snapshot.lastCycleDurationMs,
    snapshot.lastDrainAttempted,
    snapshot.lastDrainAccepted,
    snapshot.lastDrainRetriable,
    snapshot.lastDrainFatal,
    snapshot.lastDrainRecovered,
    snapshot.lastUploadError,
    snapshot.lastConsecutiveRetriableBreak === null
      ? null
      : snapshot.lastConsecutiveRetriableBreak
        ? 1
        : 0,
    JSON.stringify(snapshot.lastSourceCaptures),
  );
}

export function getDaemonState(db: Database): DaemonStateSnapshot | null {
  const row = db.query<DaemonStateRow, []>(GET_DAEMON_STATE_SQL).get();
  if (row === null) return null;
  let captures: Record<string, SourceCycleResult> = {};
  if (row.last_source_captures !== null) {
    try {
      const parsed = JSON.parse(row.last_source_captures) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        captures = parsed as Record<string, SourceCycleResult>;
      }
    } catch {
      captures = {};
    }
  }
  return {
    lastCycleStartedAt: row.last_cycle_started_at,
    lastCycleCompletedAt: row.last_cycle_completed_at,
    lastCycleDurationMs: row.last_cycle_duration_ms,
    lastDrainAttempted: row.last_drain_attempted,
    lastDrainAccepted: row.last_drain_accepted,
    lastDrainRetriable: row.last_drain_retriable,
    lastDrainFatal: row.last_drain_fatal,
    lastDrainRecovered: row.last_drain_recovered,
    lastUploadError: row.last_upload_error,
    lastConsecutiveRetriableBreak:
      row.last_consecutive_retriable_break === null
        ? null
        : row.last_consecutive_retriable_break !== 0,
    lastSourceCaptures: captures,
  };
}
