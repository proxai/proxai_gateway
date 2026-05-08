import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  countByStatus,
  getBatch,
  insertBatch,
  markBatchDelivered,
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

test('totalPendingBytes excludes delivered batches', () => {
  const a = newBatch({ body: new Uint8Array(100) });
  const b = newBatch({ body: new Uint8Array(200) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });
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
  expect(countByStatus(db)).toEqual({ pending: 0, failed: 0, delivered: 0 });
});

test('countByStatus reports one of each bucket', () => {
  const a = newBatch();
  const b = newBatch();
  const c = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });
  markBatchFailed(db, b.captureId, 'err');
  expect(countByStatus(db)).toEqual({ pending: 1, failed: 1, delivered: 1 });
});

import { countsBySource } from 'services/buffer';

test('countsBySource reports zero for all known apps on empty buffer', () => {
  const counts = countsBySource(db);
  expect(counts['claude-code']).toEqual({ pending: 0, failed: 0, delivered: 0 });
  expect(counts.cursor).toEqual({ pending: 0, failed: 0, delivered: 0 });
  expect(counts.codex).toEqual({ pending: 0, failed: 0, delivered: 0 });
});

test('countsBySource aggregates pending failed and delivered per source', () => {
  const a = newBatch({ sourceApp: 'claude-code' });
  const b = newBatch({ sourceApp: 'claude-code' });
  const c = newBatch({ sourceApp: 'cursor' });
  const d = newBatch({ sourceApp: 'codex' });
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  insertBatch(db, d);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });
  markBatchFailed(db, b.captureId, 'err');
  const counts = countsBySource(db);
  expect(counts['claude-code']).toEqual({ pending: 0, failed: 1, delivered: 1 });
  expect(counts.cursor).toEqual({ pending: 1, failed: 0, delivered: 0 });
  expect(counts.codex).toEqual({ pending: 1, failed: 0, delivered: 0 });
});

test('countsBySource ignores unknown source_app values defensively', () => {
  const a = newBatch({ sourceApp: 'claude-code' });
  insertBatch(db, a);
  db.run("UPDATE upload_batches SET source_app = 'unknown' WHERE capture_id = ?", [a.captureId]);
  const counts = countsBySource(db);
  expect(counts['claude-code'].pending).toBe(0);
});

test('countsBySource ignores unknown source_app values in receipts defensively', () => {
  const a = newBatch({ sourceApp: 'claude-code' });
  insertBatch(db, a);
  markBatchDelivered(db, getBatch(db, a.captureId)!, { idempotentOnServer: false });
  db.run("UPDATE upload_receipts SET source_app = 'unknown' WHERE capture_id = ?", [a.captureId]);
  const counts = countsBySource(db);
  expect(counts['claude-code'].delivered).toBe(0);
});
