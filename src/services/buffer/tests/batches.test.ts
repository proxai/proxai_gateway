import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7, requireDefined } from 'core/utils';
import {
  clearFailedState,
  countReceipts,
  deleteBatch,
  dropOldestPending,
  getBatch,
  getDaemonState,
  getReceipt,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  nextPendingBatch,
  nextPendingBatchAfter,
  openInMemoryBufferDb,
  recordResyncEvent,
  recordRetriableFailure,
  setDaemonState,
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
  expect(requireDefined(stored).captureId).toBe(batch.captureId);
  expect(requireDefined(stored).sourceApp).toBe(batch.sourceApp);
  expect(requireDefined(stored).watermarkStart).toBe(batch.watermarkStart);
  expect(requireDefined(stored).watermarkEnd).toBe(batch.watermarkEnd);
  expect(requireDefined(stored).body).toEqual(batch.body);
  expect(requireDefined(stored).status).toBe('pending');
  expect(requireDefined(stored).attempts).toBe(0);
  expect(requireDefined(stored).lastError).toBeNull();
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
  const stored = requireDefined(getBatch(db, batch.captureId));
  markBatchDelivered(db, stored, { idempotentOnServer: false });
  expect(nextPendingBatch(db)).toBeNull();
});

test('markBatchDelivered deletes the batch row', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));
  markBatchDelivered(db, stored, { idempotentOnServer: false });
  expect(getBatch(db, batch.captureId)).toBeNull();
});

test('markBatchDelivered inserts a receipt row with derived fields', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));
  markBatchDelivered(db, stored, {
    idempotentOnServer: false,
    deliveredAt: '2026-05-06T12:00:00.000Z',
  });

  const receipt = getReceipt(db, batch.captureId);
  expect(receipt).not.toBeNull();
  expect(requireDefined(receipt).captureId).toBe(batch.captureId);
  expect(requireDefined(receipt).sourceApp).toBe(batch.sourceApp);
  expect(requireDefined(receipt).sourcePathHash).toBe(batch.sourcePathHash);
  expect(requireDefined(receipt).watermarkKind).toBe(batch.watermarkKind);
  expect(requireDefined(receipt).watermarkStart).toBe(batch.watermarkStart);
  expect(requireDefined(receipt).watermarkEnd).toBe(batch.watermarkEnd);
  expect(requireDefined(receipt).watermarkTable).toBe(batch.watermarkTable);
  expect(requireDefined(receipt).deliveredAt).toBe('2026-05-06T12:00:00.000Z');
  expect(requireDefined(receipt).idempotentOnServer).toBe(false);
});

test('markBatchDelivered persists idempotentOnServer: true', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));
  markBatchDelivered(db, stored, { idempotentOnServer: true });

  const receipt = requireDefined(getReceipt(db, batch.captureId));
  expect(receipt.idempotentOnServer).toBe(true);
});

test('markBatchDelivered transaction is atomic on duplicate receipt', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  markBatchDelivered(db, stored, { idempotentOnServer: false });

  insertBatch(db, batch);
  expect(getBatch(db, batch.captureId)).not.toBeNull();

  const second = requireDefined(getBatch(db, batch.captureId));
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
  const stored = requireDefined(getBatch(db, batch.captureId));
  expect(stored.status).toBe('failed');
  expect(stored.lastError).toBe('400 invalid DTO');
  expect(stored.attempts).toBe(1);
});

test('markBatchFailed stamps failed_at', () => {
  const batch = newBatch({ body: new Uint8Array(10) });
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'boom', '2026-06-03T12:00:00.000Z');

  const row = db
    .query<
      { failed_at: string | null },
      [string]
    >('SELECT failed_at FROM upload_batches WHERE capture_id = ?')
    .get(batch.captureId);
  expect(row?.failed_at).toBe('2026-06-03T12:00:00.000Z');
});

test('recordRetriableFailure increments attempts and stores error without changing status', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  recordRetriableFailure(db, batch.captureId, 'network');
  recordRetriableFailure(db, batch.captureId, '503');
  const stored = requireDefined(getBatch(db, batch.captureId));
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
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });

  expect(dropOldestPending(db)).toBe(b.captureId);
});

test('dropOldestPending returns null when nothing pending', () => {
  expect(dropOldestPending(db)).toBeNull();
});

test('nextPendingBatchAfter returns next pending batch chronologically or by ID tie-breaker', async () => {
  const a = newBatch();
  const b = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);

  const storedA = requireDefined(getBatch(db, a.captureId));
  const storedB = requireDefined(getBatch(db, b.captureId));

  const next = nextPendingBatchAfter(db, {
    createdAt: storedA.createdAt,
    captureId: storedA.captureId,
  });
  expect(next?.captureId).toBe(b.captureId);

  const nextNull = nextPendingBatchAfter(db, {
    createdAt: storedB.createdAt,
    captureId: storedB.captureId,
  });
  expect(nextNull).toBeNull();
});

test('deleteBatch removes the row and getBatch returns null afterwards', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  expect(getBatch(db, batch.captureId)).not.toBeNull();
  deleteBatch(db, batch.captureId);
  expect(getBatch(db, batch.captureId)).toBeNull();
});

test('deleteBatch is a no-op for an unknown id', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  deleteBatch(db, 'non-existent-id');
  expect(getBatch(db, batch.captureId)).not.toBeNull();
});

test('clearFailedState removes failed batches, resync events, and clears last_upload_error', () => {
  const failed = newBatch({ body: new Uint8Array(50) });
  insertBatch(db, failed);
  markBatchFailed(db, failed.captureId, 'boom');

  recordResyncEvent(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'hash',
    watermarkKind: 'byte_range',
    serverWatermarkEnd: 100,
    skippedUnits: 10,
    recoveredAt: '2026-06-03T12:00:00.000Z',
  });

  setDaemonState(db, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: 'failed auth',
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });

  clearFailedState(db);

  expect(getBatch(db, failed.captureId)).toBeNull();
  expect(getDaemonState(db)?.lastUploadError).toBeNull();
  const resync = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM resync_events')
    .get();
  expect(resync?.count ?? 0).toBe(0);
});
