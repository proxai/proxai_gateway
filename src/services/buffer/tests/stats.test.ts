import { requireDefined } from 'core/utils';
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
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
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
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  markBatchFailed(db, b.captureId, 'err');
  expect(countByStatus(db)).toEqual({ pending: 1, failed: 1, delivered: 1 });
});

import {
  countsBySource,
  derivedCapturedBytes,
  derivedUploadStats,
  totalFailedBytes,
} from 'services/buffer';

test('countsBySource reports zero for all known apps on empty buffer', () => {
  const counts = countsBySource(db);
  expect(counts['claude-code']).toEqual({
    pending: 0,
    pendingBytes: 0,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
  expect(counts.cursor).toEqual({
    pending: 0,
    pendingBytes: 0,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
  expect(counts.codex).toEqual({
    pending: 0,
    pendingBytes: 0,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
  expect(counts['claude-desktop']).toEqual({
    pending: 0,
    pendingBytes: 0,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
});

test('countsBySource aggregates pending failed and delivered per source with bytes', () => {
  const a = newBatch({ sourceApp: 'claude-code', body: new Uint8Array(100) });
  const b = newBatch({ sourceApp: 'claude-code', body: new Uint8Array(200) });
  const c = newBatch({ sourceApp: 'cursor', body: new Uint8Array(300) });
  const d = newBatch({ sourceApp: 'codex', body: new Uint8Array(400) });
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  insertBatch(db, d);
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  markBatchFailed(db, b.captureId, 'err');
  const counts = countsBySource(db);
  expect(counts['claude-code']).toEqual({
    pending: 0,
    pendingBytes: 0,
    failed: 1,
    failedBytes: 200,
    delivered: 1,
  });
  expect(counts.cursor).toEqual({
    pending: 1,
    pendingBytes: 300,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
  expect(counts.codex).toEqual({
    pending: 1,
    pendingBytes: 400,
    failed: 0,
    failedBytes: 0,
    delivered: 0,
  });
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
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  db.run("UPDATE upload_receipts SET source_app = 'unknown' WHERE capture_id = ?", [a.captureId]);
  const counts = countsBySource(db);
  expect(counts['claude-code'].delivered).toBe(0);
});

test('totalFailedBytes is zero when no batches exist', () => {
  expect(totalFailedBytes(db)).toBe(0);
});

test('totalFailedBytes sums body sizes of failed batches only', () => {
  const a = newBatch({ body: new Uint8Array(50) });
  const b = newBatch({ body: new Uint8Array(75) });
  const c = newBatch({ body: new Uint8Array(100) });
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchFailed(db, a.captureId, 'timeout');
  markBatchFailed(db, b.captureId, 'network error');
  expect(totalFailedBytes(db)).toBe(125);
});

test('totalFailedBytes excludes pending and delivered batches', () => {
  const a = newBatch({ body: new Uint8Array(60) });
  const b = newBatch({ body: new Uint8Array(80) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  expect(totalFailedBytes(db)).toBe(0);
});

test('derivedUploadStats returns zero values on empty receipts table', () => {
  const stats = derivedUploadStats(db);
  expect(stats.totalBatchesUploaded).toBe(0);
  expect(stats.totalBytesUploaded).toBe(0);
  expect(stats.lastSuccessAt).toBeNull();
  expect(stats.idempotentResends).toBe(0);
  expect(stats.bySource).toEqual({});
});

test('derivedUploadStats counts delivered batches and sums shipped bytes', () => {
  const a = newBatch({ sourceApp: 'claude-code', body: new Uint8Array(120) });
  const b = newBatch({ sourceApp: 'cursor', body: new Uint8Array(80) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  markBatchDelivered(db, requireDefined(getBatch(db, b.captureId)), { idempotentOnServer: false });
  const stats = derivedUploadStats(db);
  expect(stats.totalBatchesUploaded).toBe(2);
  expect(stats.totalBytesUploaded).toBe(200);
  expect(stats.idempotentResends).toBe(0);
  expect(stats.lastSuccessAt).not.toBeNull();
});

test('derivedUploadStats counts idempotent resends separately', () => {
  const a = newBatch({ body: new Uint8Array(50) });
  const b = newBatch({ body: new Uint8Array(50) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: true });
  markBatchDelivered(db, requireDefined(getBatch(db, b.captureId)), { idempotentOnServer: false });
  const stats = derivedUploadStats(db);
  expect(stats.totalBatchesUploaded).toBe(2);
  expect(stats.idempotentResends).toBe(1);
});

test('derivedUploadStats groups shipped batches by source in bySource', () => {
  const a = newBatch({ sourceApp: 'claude-code', body: new Uint8Array(100) });
  const b = newBatch({ sourceApp: 'claude-code', body: new Uint8Array(200) });
  const c = newBatch({ sourceApp: 'codex', body: new Uint8Array(50) });
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchDelivered(db, requireDefined(getBatch(db, a.captureId)), { idempotentOnServer: false });
  markBatchDelivered(db, requireDefined(getBatch(db, b.captureId)), { idempotentOnServer: false });
  markBatchDelivered(db, requireDefined(getBatch(db, c.captureId)), { idempotentOnServer: false });
  const stats = derivedUploadStats(db);
  expect(stats.bySource['claude-code']).toEqual({ batches: 2, bytes: 300 });
  expect(stats.bySource.codex).toEqual({ batches: 1, bytes: 50 });
});

test('derivedCapturedBytes is zero when buffer is empty and no bytes uploaded', () => {
  expect(derivedCapturedBytes(db, 0)).toBe(0);
});

test('derivedCapturedBytes sums in-flight body bytes across all batch statuses and adds uploaded bytes', () => {
  const a = newBatch({ body: new Uint8Array(100) });
  const b = newBatch({ body: new Uint8Array(200) });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchFailed(db, b.captureId, 'err');
  expect(derivedCapturedBytes(db, 500)).toBe(800);
});

test('derivedCapturedBytes counts only uploadedBytes when buffer is empty', () => {
  expect(derivedCapturedBytes(db, 1024)).toBe(1024);
});
