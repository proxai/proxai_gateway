import type { Database } from 'bun:sqlite';

import { BUFFER_TABLES, QUARANTINE_COLS } from 'services/buffer/buffer.constants.ts';
import type { QuarantineRecordInput } from 'services/buffer/buffer.types.ts';
import type { SourceApp } from 'services/contract';

const INSERT_SQL = `
  INSERT INTO ${BUFFER_TABLES.quarantined} (
    ${QUARANTINE_COLS.sourceApp},
    ${QUARANTINE_COLS.sourcePath},
    ${QUARANTINE_COLS.sourcePathHash},
    ${QUARANTINE_COLS.sourceInode},
    ${QUARANTINE_COLS.watermarkTable},
    ${QUARANTINE_COLS.watermarkPosition},
    ${QUARANTINE_COLS.rowPk},
    ${QUARANTINE_COLS.redactedSizeBytes},
    ${QUARANTINE_COLS.reason},
    ${QUARANTINE_COLS.quarantinedAtUtc},
    ${QUARANTINE_COLS.gatewayVersion}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const COUNT_ALL_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.quarantined}`;

const COUNT_BY_SOURCE_SQL = `
  SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.quarantined}
  WHERE ${QUARANTINE_COLS.sourceApp} = ?
`;

const DELETE_OLDER_THAN_SQL = `
  DELETE FROM ${BUFFER_TABLES.quarantined}
  WHERE ${QUARANTINE_COLS.quarantinedAtUtc} < ?
`;

export function recordQuarantine(db: Database, input: QuarantineRecordInput): void {
  db.query(INSERT_SQL).run(
    input.sourceApp,
    input.sourcePath,
    input.sourcePathHash,
    input.sourceInode,
    input.watermarkTable,
    input.watermarkPosition,
    input.rowPk,
    input.redactedSizeBytes,
    input.reason,
    input.quarantinedAtUtc,
    input.gatewayVersion,
  );
}

export function countQuarantined(db: Database, sourceApp?: SourceApp): number {
  if (sourceApp === undefined) {
    const row = db.query<{ count: number }, []>(COUNT_ALL_SQL).get();
    return row?.count ?? 0;
  }
  const row = db.query<{ count: number }, [string]>(COUNT_BY_SOURCE_SQL).get(sourceApp);
  return row?.count ?? 0;
}

export function pruneQuarantinedOlderThan(db: Database, cutoffIsoUtc: string): number {
  const result = db.query(DELETE_OLDER_THAN_SQL).run(cutoffIsoUtc);
  return Number(result.changes ?? 0);
}
