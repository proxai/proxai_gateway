import type { Database } from 'bun:sqlite';

import { BUFFER_TABLES, RECEIPT_COLS } from 'services/buffer/buffer.constants.ts';
import type { NewReceipt, StoredReceipt } from 'services/buffer/buffer.types.ts';
import type { SourceApp, WatermarkKind } from 'services/contract';

interface ReceiptRow {
  capture_id: string;
  source_app: string;
  source_path_hash: string;
  watermark_kind: string;
  watermark_start: number;
  watermark_end: number;
  watermark_table: string | null;
  delivered_at: string;
  idempotent_on_server: number;
}

const INSERT_RECEIPT_SQL = `
  INSERT INTO ${BUFFER_TABLES.receipts} (
    ${RECEIPT_COLS.captureId},
    ${RECEIPT_COLS.sourceApp},
    ${RECEIPT_COLS.sourcePathHash},
    ${RECEIPT_COLS.watermarkKind},
    ${RECEIPT_COLS.watermarkStart},
    ${RECEIPT_COLS.watermarkEnd},
    ${RECEIPT_COLS.watermarkTable},
    ${RECEIPT_COLS.deliveredAt},
    ${RECEIPT_COLS.idempotentOnServer}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const GET_RECEIPT_SQL = `
  SELECT * FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.captureId} = ?
`;

const HAS_RECEIPT_SQL = `
  SELECT 1 AS present FROM ${BUFFER_TABLES.receipts}
  WHERE ${RECEIPT_COLS.captureId} = ?
  LIMIT 1
`;

const COUNT_RECEIPTS_SQL = `SELECT COUNT(*) AS count FROM ${BUFFER_TABLES.receipts}`;

export function insertReceipt(db: Database, receipt: NewReceipt): void {
  db.query(INSERT_RECEIPT_SQL).run(
    receipt.captureId,
    receipt.sourceApp,
    receipt.sourcePathHash,
    receipt.watermarkKind,
    receipt.watermarkStart,
    receipt.watermarkEnd,
    receipt.watermarkTable,
    receipt.deliveredAt,
    receipt.idempotentOnServer ? 1 : 0,
  );
}

export function getReceipt(db: Database, captureId: string): StoredReceipt | null {
  const row = db.query<ReceiptRow, [string]>(GET_RECEIPT_SQL).get(captureId);
  return row === null ? null : rowToReceipt(row);
}

export function hasReceipt(db: Database, captureId: string): boolean {
  const row = db.query<{ present: number }, [string]>(HAS_RECEIPT_SQL).get(captureId);
  return row !== null;
}

export function countReceipts(db: Database): number {
  const row = db.query<{ count: number }, []>(COUNT_RECEIPTS_SQL).get();
  return row?.count ?? 0;
}

function rowToReceipt(row: ReceiptRow): StoredReceipt {
  return {
    captureId: row.capture_id,
    sourceApp: row.source_app as SourceApp,
    sourcePathHash: row.source_path_hash,
    watermarkKind: row.watermark_kind as WatermarkKind,
    watermarkStart: row.watermark_start,
    watermarkEnd: row.watermark_end,
    watermarkTable: row.watermark_table,
    deliveredAt: row.delivered_at,
    idempotentOnServer: row.idempotent_on_server !== 0,
  };
}
