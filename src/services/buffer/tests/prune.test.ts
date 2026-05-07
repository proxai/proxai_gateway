import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  countByStatus,
  countReceipts,
  getBatch,
  getLastPruneAt,
  insertBatch,
  insertReceipt,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
  pruneBuffer,
} from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';
import { generateUuidV7 } from 'core/utils';

const DAY_MS = 86_400_000;

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

test('deletes receipts older than retention; keeps recent receipts', () => {
  
  insertReceipt(db, {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourcePathHash: 'h'.repeat(64),
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1,
    watermarkTable: null,
    deliveredAt: isoDaysAgo(0),
    idempotentOnServer: false,
  });
  insertReceipt(db, {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourcePathHash: 'h'.repeat(64),
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1,
    watermarkTable: null,
    deliveredAt: isoDaysAgo(45),
    idempotentOnServer: false,
  });
  expect(countReceipts(db)).toBe(2);

  const result = pruneBuffer({ db, receiptRetentionDays: 30, failedRetentionDays: 30 });
  expect(result.receiptsDeleted).toBe(1);
  expect(result.receiptBytesFreed).toBeGreaterThan(0);
  expect(countReceipts(db)).toBe(1);
});

test('deletes failed batches older than retention; keeps recent failed and pending', () => {
  
  
  const oldFailed = newBatch({ body: new Uint8Array(100) });
  const recentFailed = newBatch({ body: new Uint8Array(200) });
  const pending = newBatch({ body: new Uint8Array(300) });
  insertBatch(db, oldFailed);
  insertBatch(db, recentFailed);
  insertBatch(db, pending);
  markBatchFailed(db, oldFailed.captureId, 'old');
  markBatchFailed(db, recentFailed.captureId, 'recent');
  
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    isoDaysAgo(45),
    oldFailed.captureId,
  ]);

  const before = countByStatus(db);
  expect(before.failed).toBe(2);
  expect(before.pending).toBe(1);

  const result = pruneBuffer({ db, receiptRetentionDays: 30, failedRetentionDays: 30 });
  expect(result.failedBatchesDeleted).toBe(1);
  expect(result.failedBytesFreed).toBe(100);

  const after = countByStatus(db);
  expect(after.failed).toBe(1);
  expect(after.pending).toBe(1);
  expect(getBatch(db, oldFailed.captureId)).toBeNull();
  expect(getBatch(db, recentFailed.captureId)).not.toBeNull();
  expect(getBatch(db, pending.captureId)).not.toBeNull();
});

test('does not delete pending batches even if older than retention', () => {
  const oldPending = newBatch({ body: new Uint8Array(100) });
  insertBatch(db, oldPending);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    isoDaysAgo(120),
    oldPending.captureId,
  ]);
  const result = pruneBuffer({ db, receiptRetentionDays: 30, failedRetentionDays: 30 });
  expect(result.failedBatchesDeleted).toBe(0);
  expect(getBatch(db, oldPending.captureId)).not.toBeNull();
});

test('returns zeroes when nothing to prune', () => {
  const result = pruneBuffer({ db, receiptRetentionDays: 30, failedRetentionDays: 30 });
  expect(result.receiptsDeleted).toBe(0);
  expect(result.failedBatchesDeleted).toBe(0);
  expect(result.receiptBytesFreed).toBe(0);
  expect(result.failedBytesFreed).toBe(0);
});

test('uses custom retention windows', () => {
  insertReceipt(db, {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourcePathHash: 'h'.repeat(64),
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1,
    watermarkTable: null,
    deliveredAt: isoDaysAgo(5),
    idempotentOnServer: false,
  });
  
  const result = pruneBuffer({ db, receiptRetentionDays: 1, failedRetentionDays: 30 });
  expect(result.receiptsDeleted).toBe(1);
});

test('records last_prune_at metadata', () => {
  expect(getLastPruneAt(db)).toBeNull();
  const fixedNow = new Date('2026-05-06T12:00:00.000Z');
  pruneBuffer({ db, receiptRetentionDays: 30, failedRetentionDays: 30, now: fixedNow });
  expect(getLastPruneAt(db)).toBe('2026-05-06T12:00:00.000Z');
});

test('respects an injected now() value when computing cutoffs', () => {
  
  
  const stableId = generateUuidV7();
  insertReceipt(db, {
    captureId: stableId,
    sourceApp: 'claude-code',
    sourcePathHash: 'h'.repeat(64),
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 1,
    watermarkTable: null,
    deliveredAt: '2026-01-01T00:00:00.000Z',
    idempotentOnServer: false,
  });
  
  
  const result1 = pruneBuffer({
    db,
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    now: new Date('2026-01-15T00:00:00.000Z'),
  });
  expect(result1.receiptsDeleted).toBe(0);
  
  const result2 = pruneBuffer({
    db,
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    now: new Date('2026-03-15T00:00:00.000Z'),
  });
  expect(result2.receiptsDeleted).toBe(1);
});

test('runs in a single transaction (delivered batches with markBatchDelivered + then prune)', () => {
  
  const a = newBatch();
  insertBatch(db, a);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });
  
  const result = pruneBuffer({
    db,
    receiptRetentionDays: 0,
    failedRetentionDays: 30,
    
    now: new Date(Date.now() + 1000),
  });
  expect(result.receiptsDeleted).toBe(1);
  expect(countReceipts(db)).toBe(0);
});
