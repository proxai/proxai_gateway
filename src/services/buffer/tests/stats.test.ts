import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  countByStatus,
  insertBatch,
  markBatchDone,
  markBatchFailed,
  openInMemoryBufferDb,
  totalPendingBytes,
} from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('totalPendingBytes is zero for an empty buffer', () => {
  expect(totalPendingBytes(db)).toBe(0);
});

test('totalPendingBytes sums body sizes for pending batches', () => {
  insertBatch(db, newBatch({ body: new Uint8Array(100) }));
  insertBatch(db, newBatch({ body: new Uint8Array(200) }));
  expect(totalPendingBytes(db)).toBe(300);
});

test('totalPendingBytes excludes done batches', () => {
  const a = newBatch({ body: new Uint8Array(100) });
  const b = newBatch({ body: new Uint8Array(200) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDone(db, a.captureId);
  expect(totalPendingBytes(db)).toBe(200);
});

test('totalPendingBytes excludes failed batches', () => {
  const a = newBatch({ body: new Uint8Array(100) });
  const b = newBatch({ body: new Uint8Array(200) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchFailed(db, a.captureId, 'err');
  expect(totalPendingBytes(db)).toBe(200);
});

test('countByStatus reports zero buckets when empty', () => {
  expect(countByStatus(db)).toEqual({ pending: 0, done: 0, failed: 0 });
});

test('countByStatus reports one of each status', () => {
  const a = newBatch();
  const b = newBatch();
  const c = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchDone(db, a.captureId);
  markBatchFailed(db, b.captureId, 'err');
  expect(countByStatus(db)).toEqual({ pending: 1, done: 1, failed: 1 });
});
