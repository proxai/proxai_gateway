import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7, requireDefined } from 'core/utils';
import {
  insertBatch,
  insertReceipt,
  markBatchFailed,
  openInMemoryBufferDb,
  recordQuarantine,
} from 'services/buffer';
import type { NewReceipt, QuarantineRecordInput } from 'services/buffer';
import {
  queryFailed,
  queryPending,
  queryQuarantined,
  queryUploaded,
} from 'services/buffer/logs-queries.ts';
import { newBatch } from 'services/buffer/tests/fixtures.ts';

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

function newQuarantine(overrides: Partial<QuarantineRecordInput> = {}): QuarantineRecordInput {
  return {
    sourceApp: 'codex',
    sourcePath: '/tmp/state.sqlite',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkPosition: 1,
    rowPk: '1',
    redactedSizeBytes: 11_000_000,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    gatewayVersion: 'gw-0.1',
    ...overrides,
  };
}

test('queryUploaded returns an empty array when there are no receipts', () => {
  expect(queryUploaded(db, { limit: 10 })).toEqual([]);
});

test('queryUploaded maps receipt columns and idempotentOnServer flag', () => {
  insertReceipt(
    db,
    newReceipt({
      sourceApp: 'cursor',
      deliveredAt: '2026-05-06T12:00:00.000Z',
      watermarkKind: 'rowid_range',
      sourcePathHash: 'b'.repeat(64),
      idempotentOnServer: true,
    }),
  );
  const rows = queryUploaded(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  const first = requireDefined(rows[0]);
  expect(first).toEqual({
    captureId: first.captureId,
    sourceApp: 'cursor',
    deliveredAt: '2026-05-06T12:00:00.000Z',
    watermarkKind: 'rowid_range',
    sourcePathHash: 'b'.repeat(64),
    idempotentOnServer: true,
    sourcePath: null,
  });
});

test('queryUploaded maps idempotentOnServer false', () => {
  insertReceipt(db, newReceipt({ idempotentOnServer: false }));
  const rows = queryUploaded(db, { limit: 10 });
  expect(requireDefined(rows[0]).idempotentOnServer).toBe(false);
});

test('queryUploaded orders by deliveredAt descending and respects limit', () => {
  insertReceipt(db, newReceipt({ deliveredAt: '2026-05-01T00:00:00.000Z' }));
  insertReceipt(db, newReceipt({ deliveredAt: '2026-05-03T00:00:00.000Z' }));
  insertReceipt(db, newReceipt({ deliveredAt: '2026-05-02T00:00:00.000Z' }));
  const rows = queryUploaded(db, { limit: 2 });
  expect(rows.map((r) => r.deliveredAt)).toEqual([
    '2026-05-03T00:00:00.000Z',
    '2026-05-02T00:00:00.000Z',
  ]);
});

test('queryUploaded filters by sourceApp', () => {
  insertReceipt(db, newReceipt({ sourceApp: 'claude-code' }));
  insertReceipt(db, newReceipt({ sourceApp: 'cursor' }));
  const rows = queryUploaded(db, { limit: 10, sourceApp: 'cursor' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).sourceApp).toBe('cursor');
});

test('queryUploaded filters by sinceIso', () => {
  insertReceipt(db, newReceipt({ deliveredAt: '2026-05-01T00:00:00.000Z' }));
  insertReceipt(db, newReceipt({ deliveredAt: '2026-05-10T00:00:00.000Z' }));
  const rows = queryUploaded(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' });
  expect(rows.map((r) => r.deliveredAt)).toEqual(['2026-05-10T00:00:00.000Z']);
});

test('queryUploaded combines sourceApp and sinceIso filters', () => {
  insertReceipt(db, newReceipt({ sourceApp: 'cursor', deliveredAt: '2026-05-10T00:00:00.000Z' }));
  insertReceipt(db, newReceipt({ sourceApp: 'cursor', deliveredAt: '2026-05-01T00:00:00.000Z' }));
  insertReceipt(db, newReceipt({ sourceApp: 'codex', deliveredAt: '2026-05-10T00:00:00.000Z' }));
  const rows = queryUploaded(db, {
    limit: 10,
    sourceApp: 'cursor',
    sinceIso: '2026-05-05T00:00:00.000Z',
  });
  expect(rows).toHaveLength(1);
  const first = requireDefined(rows[0]);
  expect(first.sourceApp).toBe('cursor');
  expect(first.deliveredAt).toBe('2026-05-10T00:00:00.000Z');
});

test('queryFailed returns an empty array when there are no failed batches', () => {
  insertBatch(db, newBatch());
  expect(queryFailed(db, { limit: 10 })).toEqual([]);
});

test('queryFailed maps failed batch columns including a populated lastError', () => {
  const batch = newBatch({ sourceApp: 'cursor', sourcePath: '/Users/test/state.vscdb' });
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'boom');
  const rows = queryFailed(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0])).toEqual({
    captureId: batch.captureId,
    sourceApp: 'cursor',
    capturedAtUtc: batch.capturedAtUtc,
    sourcePath: '/Users/test/state.vscdb',
    attempts: 1,
    lastError: 'boom',
    sourcePathHash: 'a'.repeat(64),
  });
});

test('queryFailed maps a NULL lastError to null', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  db.run("UPDATE upload_batches SET status = 'failed', last_error = NULL WHERE capture_id = ?", [
    batch.captureId,
  ]);
  const rows = queryFailed(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).lastError).toBeNull();
});

test('queryFailed orders by createdAt descending and respects limit', () => {
  const a = newBatch();
  const b = newBatch();
  const c = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchFailed(db, a.captureId, 'a');
  markBatchFailed(db, b.captureId, 'b');
  markBatchFailed(db, c.captureId, 'c');
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-01T00:00:00.000Z',
    a.captureId,
  ]);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-03T00:00:00.000Z',
    b.captureId,
  ]);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-02T00:00:00.000Z',
    c.captureId,
  ]);
  const rows = queryFailed(db, { limit: 2 });
  expect(rows.map((r) => r.captureId)).toEqual([b.captureId, c.captureId]);
});

test('queryFailed filters by sourceApp', () => {
  const a = newBatch({ sourceApp: 'claude-code' });
  const b = newBatch({ sourceApp: 'codex' });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchFailed(db, a.captureId, 'a');
  markBatchFailed(db, b.captureId, 'b');
  const rows = queryFailed(db, { limit: 10, sourceApp: 'codex' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).sourceApp).toBe('codex');
});

test('queryFailed filters by sinceIso on capturedAtUtc', () => {
  const a = newBatch({ capturedAtUtc: '2026-05-01T00:00:00.000Z' });
  const b = newBatch({ capturedAtUtc: '2026-05-10T00:00:00.000Z' });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchFailed(db, a.captureId, 'a');
  markBatchFailed(db, b.captureId, 'b');
  const rows = queryFailed(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).capturedAtUtc).toBe('2026-05-10T00:00:00.000Z');
});

test('queryQuarantined returns an empty array when there are no records', () => {
  expect(queryQuarantined(db, { limit: 10 })).toEqual([]);
});

test('queryQuarantined maps quarantine columns', () => {
  recordQuarantine(
    db,
    newQuarantine({
      sourceApp: 'codex',
      sourcePath: '/tmp/state_5.sqlite',
      redactedSizeBytes: 9_000_000,
      reason: 'oversized_decompressed',
      quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    }),
  );
  const rows = queryQuarantined(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  const first = requireDefined(rows[0]);
  expect(first).toEqual({
    id: first.id,
    sourceApp: 'codex',
    sourcePath: '/tmp/state_5.sqlite',
    redactedSizeBytes: 9_000_000,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    sourcePathHash: 'a'.repeat(64),
  });
  expect(typeof first.id).toBe('number');
});

test('queryQuarantined orders by quarantinedAtUtc descending and respects limit', () => {
  recordQuarantine(db, newQuarantine({ quarantinedAtUtc: '2026-05-01T00:00:00.000Z' }));
  recordQuarantine(db, newQuarantine({ quarantinedAtUtc: '2026-05-03T00:00:00.000Z' }));
  recordQuarantine(db, newQuarantine({ quarantinedAtUtc: '2026-05-02T00:00:00.000Z' }));
  const rows = queryQuarantined(db, { limit: 2 });
  expect(rows.map((r) => r.quarantinedAtUtc)).toEqual([
    '2026-05-03T00:00:00.000Z',
    '2026-05-02T00:00:00.000Z',
  ]);
});

test('queryQuarantined filters by sourceApp', () => {
  recordQuarantine(db, newQuarantine({ sourceApp: 'codex' }));
  recordQuarantine(db, newQuarantine({ sourceApp: 'cursor' }));
  const rows = queryQuarantined(db, { limit: 10, sourceApp: 'cursor' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).sourceApp).toBe('cursor');
});

test('queryQuarantined filters by sinceIso on quarantinedAtUtc', () => {
  recordQuarantine(db, newQuarantine({ quarantinedAtUtc: '2026-05-01T00:00:00.000Z' }));
  recordQuarantine(db, newQuarantine({ quarantinedAtUtc: '2026-05-10T00:00:00.000Z' }));
  const rows = queryQuarantined(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).quarantinedAtUtc).toBe('2026-05-10T00:00:00.000Z');
});

test('queryPending returns an empty array when there are no pending batches', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'gone');
  expect(queryPending(db, { limit: 10 })).toEqual([]);
});

test('queryPending maps pending batch columns', () => {
  const batch = newBatch({ sourceApp: 'gemini-cli', sourcePath: '/Users/test/g.log' });
  insertBatch(db, batch);
  const rows = queryPending(db, { limit: 10 });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0])).toEqual({
    captureId: batch.captureId,
    sourceApp: 'gemini-cli',
    capturedAtUtc: batch.capturedAtUtc,
    sourcePath: '/Users/test/g.log',
    attempts: 0,
    sourcePathHash: 'a'.repeat(64),
  });
});

test('queryPending orders by createdAt descending and respects limit', () => {
  const a = newBatch();
  const b = newBatch();
  const c = newBatch();
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-01T00:00:00.000Z',
    a.captureId,
  ]);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-03T00:00:00.000Z',
    b.captureId,
  ]);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-02T00:00:00.000Z',
    c.captureId,
  ]);
  const rows = queryPending(db, { limit: 2 });
  expect(rows.map((r) => r.captureId)).toEqual([b.captureId, c.captureId]);
});

test('queryPending filters by sourceApp', () => {
  insertBatch(db, newBatch({ sourceApp: 'claude-code' }));
  insertBatch(db, newBatch({ sourceApp: 'cursor' }));
  const rows = queryPending(db, { limit: 10, sourceApp: 'cursor' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).sourceApp).toBe('cursor');
});

test('queryPending filters by sinceIso on capturedAtUtc', () => {
  insertBatch(db, newBatch({ capturedAtUtc: '2026-05-01T00:00:00.000Z' }));
  insertBatch(db, newBatch({ capturedAtUtc: '2026-05-10T00:00:00.000Z' }));
  const rows = queryPending(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' });
  expect(rows).toHaveLength(1);
  expect(requireDefined(rows[0]).capturedAtUtc).toBe('2026-05-10T00:00:00.000Z');
});
