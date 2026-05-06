import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7 } from 'core/utils';
import {
  countReceipts,
  getReceipt,
  hasReceipt,
  insertReceipt,
  openInMemoryBufferDb,
} from 'services/buffer';
import type { NewReceipt } from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

function newReceipt(overrides: Partial<NewReceipt> = {}): NewReceipt {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourcePathHash: 'a'.repeat(64),
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1024,
    watermarkTable: null,
    deliveredAt: '2026-05-06T12:00:00.000Z',
    idempotentOnServer: false,
    ...overrides,
  };
}

test('insertReceipt + getReceipt round-trips all fields', () => {
  const receipt = newReceipt({
    watermarkTable: 'threads',
    idempotentOnServer: true,
  });
  insertReceipt(db, receipt);
  const stored = getReceipt(db, receipt.captureId);
  expect(stored).not.toBeNull();
  expect(stored!.captureId).toBe(receipt.captureId);
  expect(stored!.sourceApp).toBe(receipt.sourceApp);
  expect(stored!.sourcePathHash).toBe(receipt.sourcePathHash);
  expect(stored!.watermarkKind).toBe(receipt.watermarkKind);
  expect(stored!.watermarkStart).toBe(receipt.watermarkStart);
  expect(stored!.watermarkEnd).toBe(receipt.watermarkEnd);
  expect(stored!.watermarkTable).toBe('threads');
  expect(stored!.deliveredAt).toBe(receipt.deliveredAt);
  expect(stored!.idempotentOnServer).toBe(true);
});

test('getReceipt returns null for unknown capture_id', () => {
  expect(getReceipt(db, generateUuidV7())).toBeNull();
});

test('hasReceipt returns true/false correctly', () => {
  const receipt = newReceipt();
  expect(hasReceipt(db, receipt.captureId)).toBe(false);
  insertReceipt(db, receipt);
  expect(hasReceipt(db, receipt.captureId)).toBe(true);
  expect(hasReceipt(db, generateUuidV7())).toBe(false);
});

test('countReceipts returns the correct count', () => {
  expect(countReceipts(db)).toBe(0);
  insertReceipt(db, newReceipt());
  insertReceipt(db, newReceipt());
  insertReceipt(db, newReceipt());
  expect(countReceipts(db)).toBe(3);
});

test('receipt with watermarkTable: null round-trips as null', () => {
  const receipt = newReceipt({ watermarkTable: null });
  insertReceipt(db, receipt);
  const stored = getReceipt(db, receipt.captureId)!;
  expect(stored.watermarkTable).toBeNull();
});

test('idempotentOnServer: false persists as false', () => {
  const receipt = newReceipt({ idempotentOnServer: false });
  insertReceipt(db, receipt);
  expect(getReceipt(db, receipt.captureId)!.idempotentOnServer).toBe(false);
});
