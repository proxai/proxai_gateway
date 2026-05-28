import type { Database } from 'bun:sqlite';

import { BUFFER_TABLES, RESYNC_EVENT_COLS } from 'services/buffer/buffer.constants.ts';
import type { SourceApp, WatermarkKind } from 'services/contract';

export interface ResyncEventInput {
  sourceApp: SourceApp;
  sourcePathHash: string;
  watermarkKind: WatermarkKind;
  serverWatermarkEnd: number;
  skippedUnits: number;
  recoveredAt: string;
}

export interface StoredResyncEvent extends ResyncEventInput {
  id: number;
}

interface ResyncEventRow {
  id: number;
  source_app: string;
  source_path_hash: string;
  watermark_kind: string;
  server_watermark_end: number;
  skipped_units: number;
  recovered_at: string;
}

const INSERT_RESYNC_EVENT_SQL = `
  INSERT INTO ${BUFFER_TABLES.resyncEvents} (
    ${RESYNC_EVENT_COLS.sourceApp},
    ${RESYNC_EVENT_COLS.sourcePathHash},
    ${RESYNC_EVENT_COLS.watermarkKind},
    ${RESYNC_EVENT_COLS.serverWatermarkEnd},
    ${RESYNC_EVENT_COLS.skippedUnits},
    ${RESYNC_EVENT_COLS.recoveredAt}
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

const COUNT_RESYNC_EVENTS_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.resyncEvents}`;

const RECENT_RESYNC_EVENTS_SQL = `
  SELECT * FROM ${BUFFER_TABLES.resyncEvents}
  ORDER BY ${RESYNC_EVENT_COLS.recoveredAt} DESC
  LIMIT ?
`;

export function recordResyncEvent(db: Database, input: ResyncEventInput): void {
  db.query(INSERT_RESYNC_EVENT_SQL).run(
    input.sourceApp,
    input.sourcePathHash,
    input.watermarkKind,
    input.serverWatermarkEnd,
    input.skippedUnits,
    input.recoveredAt,
  );
}

export function countResyncEvents(db: Database): number {
  const row = db.query<{ count: number }, []>(COUNT_RESYNC_EVENTS_SQL).get();
  return row?.count ?? 0;
}

export function recentResyncEvents(db: Database, limit: number): StoredResyncEvent[] {
  const rows = db.query<ResyncEventRow, [number]>(RECENT_RESYNC_EVENTS_SQL).all(limit);
  return rows.map(rowToResyncEvent);
}

function rowToResyncEvent(row: ResyncEventRow): StoredResyncEvent {
  return {
    id: row.id,
    sourceApp: row.source_app as SourceApp,
    sourcePathHash: row.source_path_hash,
    watermarkKind: row.watermark_kind as WatermarkKind,
    serverWatermarkEnd: row.server_watermark_end,
    skippedUnits: row.skipped_units,
    recoveredAt: row.recovered_at,
  };
}
