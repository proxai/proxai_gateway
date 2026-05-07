import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7 } from 'core/utils';
import {
  countReceipts,
  dropOldestPending,
  getBatch,
  getReceipt,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  nextPendingBatch,
  openInMemoryBufferDb,
  recordRetriableFailure,
} from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('insertBatch + getBatch round-trip preserves all fields', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId);
  expect(stored).not.toBeNull();
  expect(stored!.captureId).toBe(batch.captureId);
  expect(stored!.sourceApp).toBe(batch.sourceApp);
  expect(stored!.watermarkStart).toBe(batch.watermarkStart);
  expect(stored!.watermarkEnd).toBe(batch.watermarkEnd);
  expect(stored!.body).toEqual(batch.body);
  expect(stored!.status).toBe('pending');
  expect(stored!.attempts).toBe(0);
  expect(stored!.lastError).toBeNull();
});

test('getBatch returns null for unknown id', () => {
  expect(getBatch(db, generateUuidV7())).toBeNull();
});

test('insertBatch supports null source_inode for sqlite snapshots', () => {
  const batch = newBatch({
    sourceApp: 'cursor',
    sourceKind: 'sqlite_kv_snapshot',
    sourceInode: null,
    watermarkKind: 'rowid_range',
    bodyFormat: 'kv_pairs_json',
  });
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId);
  expect(stored?.sourceInode).toBeNull();
});

test('nextPendingBatch returns the oldest pending batch', async () => {
  const a = newBatch();
  insertBatch(db, a);
  await Bun.sleep(5);
  const b = newBatch();
  insertBatch(db, b);
  expect(nextPendingBatch(db)?.captureId).toBe(a.captureId);
});

test('nextPendingBatch returns null when nothing pending', () => {
  expect(nextPendingBatch(db)).toBeNull();
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;
  markBatchDelivered(db, stored, { idempotentOnServer: false });
  expect(nextPendingBatch(db)).toBeNull();
});

test('markBatchDelivered deletes the batch row', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;
  markBatchDelivered(db, stored, { idempotentOnServer: false });
  expect(getBatch(db, batch.captureId)).toBeNull();
});

test('markBatchDelivered inserts a receipt row with derived fields', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;
  markBatchDelivered(db, stored, {
    idempotentOnServer: false,
    deliveredAt: '2026-05-06T12:00:00.000Z',
  });

  const receipt = getReceipt(db, batch.captureId);
  expect(receipt).not.toBeNull();
  expect(receipt!.captureId).toBe(batch.captureId);
  expect(receipt!.sourceApp).toBe(batch.sourceApp);
  expect(receipt!.sourcePathHash).toBe(batch.sourcePathHash);
  expect(receipt!.watermarkKind).toBe(batch.watermarkKind);
  expect(receipt!.watermarkStart).toBe(batch.watermarkStart);
  expect(receipt!.watermarkEnd).toBe(batch.watermarkEnd);
  expect(receipt!.watermarkTable).toBe(batch.watermarkTable);
  expect(receipt!.deliveredAt).toBe('2026-05-06T12:00:00.000Z');
  expect(receipt!.idempotentOnServer).toBe(false);
});

test('markBatchDelivered persists idempotentOnServer: true', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;
  markBatchDelivered(db, stored, { idempotentOnServer: true });

  const receipt = getReceipt(db, batch.captureId)!;
  expect(receipt.idempotentOnServer).toBe(true);
});

test('markBatchDelivered transaction is atomic on duplicate receipt', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  markBatchDelivered(db, stored, { idempotentOnServer: false });

  insertBatch(db, batch);
  expect(getBatch(db, batch.captureId)).not.toBeNull();

  const second = getBatch(db, batch.captureId)!;
  expect(() => {
    markBatchDelivered(db, second, { idempotentOnServer: false });
  }).toThrow();

  expect(getBatch(db, batch.captureId)).not.toBeNull();
  expect(countReceipts(db)).toBe(1);
});

test('markBatchFailed sets status, error, attempts', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, '400 invalid DTO');
  const stored = getBatch(db, batch.captureId)!;
  expect(stored.status).toBe('failed');
  expect(stored.lastError).toBe('400 invalid DTO');
  expect(stored.attempts).toBe(1);
});

test('recordRetriableFailure increments attempts and stores error without changing status', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  recordRetriableFailure(db, batch.captureId, 'network');
  recordRetriableFailure(db, batch.captureId, '503');
  const stored = getBatch(db, batch.captureId)!;
  expect(stored.status).toBe('pending');
  expect(stored.attempts).toBe(2);
  expect(stored.lastError).toBe('503');
});

test('dropOldestPending removes oldest pending and returns its id', async () => {
  const a = newBatch();
  insertBatch(db, a);
  await Bun.sleep(5);
  const b = newBatch();
  insertBatch(db, b);

  expect(dropOldestPending(db)).toBe(a.captureId);
  expect(getBatch(db, a.captureId)).toBeNull();
  expect(getBatch(db, b.captureId)).not.toBeNull();
});

test('dropOldestPending skips delivered (already-removed) and failed batches', () => {
  const a = newBatch();
  const b = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });

  expect(dropOldestPending(db)).toBe(b.captureId);
});

test('dropOldestPending returns null when nothing pending', () => {
  expect(dropOldestPending(db)).toBeNull();
});
