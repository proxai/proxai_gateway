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
  queryByCaptureId,
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

test('queryUploaded maps receipt columns including prompt and detail fields', () => {
  insertReceipt(
    db,
    newReceipt({
      sourceApp: 'cursor',
      watermarkKind: 'rowid_range',
      sourcePathHash: 'b'.repeat(64),
      idempotentOnServer: true,
      userPrompt: 'fix the bug',
      userPromptAddedAt: '2026-05-06T11:59:00.000Z',
      sourcePath: '/Users/test/state.vscdb',
      agentSchemaVersion: 'cursor/1.2',
      gatewayVersion: '2026.5.6',
      capturedAtUtc: '2026-05-06T11:58:00.000Z',
      attempts: 2,
      shippedBytes: 4096,
    }),
  );
  const first = requireDefined(queryUploaded(db, { limit: 10 })[0]);
  expect(first.sourceApp).toBe('cursor');
  expect(first.idempotentOnServer).toBe(true);
  expect(first.userPrompt).toBe('fix the bug');
  expect(first.userPromptAddedAt).toBe('2026-05-06T11:59:00.000Z');
  expect(first.sourcePath).toBe('/Users/test/state.vscdb');
  expect(first.watermarkKind).toBe('rowid_range');
  expect(first.watermarkStart).toBe(0);
  expect(first.watermarkEnd).toBe(1024);
  expect(first.agentSchemaVersion).toBe('cursor/1.2');
  expect(first.gatewayVersion).toBe('2026.5.6');
  expect(first.capturedAtUtc).toBe('2026-05-06T11:58:00.000Z');
  expect(first.shippedBytes).toBe(4096);
  expect(first.attempts).toBe(2);
});

test('queryUploaded maps absent optional fields to null and idempotent false', () => {
  insertReceipt(db, newReceipt({ idempotentOnServer: false }));
  const first = requireDefined(queryUploaded(db, { limit: 10 })[0]);
  expect(first.idempotentOnServer).toBe(false);
  expect(first.userPrompt).toBeNull();
  expect(first.userPromptAddedAt).toBeNull();
  expect(first.agentSchemaVersion).toBeNull();
  expect(first.shippedBytes).toBeNull();
  expect(first.attempts).toBeNull();
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
  expect(requireDefined(rows[0]).deliveredAt).toBe('2026-05-10T00:00:00.000Z');
});

test('queryFailed returns an empty array when there are no failed batches', () => {
  insertBatch(db, newBatch());
  expect(queryFailed(db, { limit: 10 })).toEqual([]);
});

test('queryFailed maps failed batch columns including body, size, and detail', () => {
  const batch = newBatch({
    sourceApp: 'cursor',
    sourcePath: '/Users/test/state.vscdb',
    body: new Uint8Array([1, 2, 3, 4, 5]),
  });
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'boom');
  const first = requireDefined(queryFailed(db, { limit: 10 })[0]);
  expect(first.captureId).toBe(batch.captureId);
  expect(first.sourceApp).toBe('cursor');
  expect(first.sourcePath).toBe('/Users/test/state.vscdb');
  expect(first.attempts).toBe(1);
  expect(first.lastError).toBe('boom');
  expect(first.watermarkKind).toBe('byte_range');
  expect(first.agentSchemaVersion).toBe('2.1.122');
  expect(first.gatewayVersion).toBe('@proxai/gateway 0.1.0');
  expect(first.sourceInode).toBe(12345);
  expect(first.sizeBytes).toBe(5);
  expect(first.bodyFormat).toBe('jsonl');
  expect(first.body).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
});

test('queryFailed maps a NULL lastError to null', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  db.run("UPDATE upload_batches SET status = 'failed', last_error = NULL WHERE capture_id = ?", [
    batch.captureId,
  ]);
  expect(requireDefined(queryFailed(db, { limit: 10 })[0]).lastError).toBeNull();
});

test('queryFailed orders by createdAt descending and respects limit', () => {
  const a = newBatch();
  const b = newBatch();
  const c = newBatch();
  for (const batch of [a, b, c]) insertBatch(db, batch);
  for (const batch of [a, b, c]) markBatchFailed(db, batch.captureId, 'x');
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

test('queryFailed filters by sourceApp and sinceIso', () => {
  const a = newBatch({ sourceApp: 'claude-code', capturedAtUtc: '2026-05-01T00:00:00.000Z' });
  const b = newBatch({ sourceApp: 'codex', capturedAtUtc: '2026-05-10T00:00:00.000Z' });
  insertBatch(db, a);
  insertBatch(db, b);
  markBatchFailed(db, a.captureId, 'a');
  markBatchFailed(db, b.captureId, 'b');
  expect(queryFailed(db, { limit: 10, sourceApp: 'codex' })).toHaveLength(1);
  const since = queryFailed(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' });
  expect(since).toHaveLength(1);
  expect(requireDefined(since[0]).capturedAtUtc).toBe('2026-05-10T00:00:00.000Z');
});

test('queryQuarantined returns an empty array when there are no records', () => {
  expect(queryQuarantined(db, { limit: 10 })).toEqual([]);
});

test('queryQuarantined maps quarantine columns', () => {
  recordQuarantine(
    db,
    newQuarantine({ sourcePath: '/tmp/state_5.sqlite', redactedSizeBytes: 9_000_000 }),
  );
  const first = requireDefined(queryQuarantined(db, { limit: 10 })[0]);
  expect(first.sourceApp).toBe('codex');
  expect(first.sourcePath).toBe('/tmp/state_5.sqlite');
  expect(first.redactedSizeBytes).toBe(9_000_000);
  expect(first.reason).toBe('oversized_decompressed');
  expect(typeof first.id).toBe('number');
});

test('queryQuarantined orders descending and filters by source and since', () => {
  recordQuarantine(
    db,
    newQuarantine({ sourceApp: 'codex', quarantinedAtUtc: '2026-05-01T00:00:00.000Z' }),
  );
  recordQuarantine(
    db,
    newQuarantine({ sourceApp: 'cursor', quarantinedAtUtc: '2026-05-10T00:00:00.000Z' }),
  );
  expect(queryQuarantined(db, { limit: 1 }).map((r) => r.quarantinedAtUtc)).toEqual([
    '2026-05-10T00:00:00.000Z',
  ]);
  expect(queryQuarantined(db, { limit: 10, sourceApp: 'cursor' })).toHaveLength(1);
  expect(queryQuarantined(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' })).toHaveLength(1);
});

test('queryPending returns an empty array when there are no pending batches', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'gone');
  expect(queryPending(db, { limit: 10 })).toEqual([]);
});

test('queryPending maps pending batch columns including body', () => {
  const batch = newBatch({
    sourceApp: 'claude-desktop',
    sourcePath: '/Users/test/claude-desktop.log',
    body: new Uint8Array([9, 9, 9]),
  });
  insertBatch(db, batch);
  const first = requireDefined(queryPending(db, { limit: 10 })[0]);
  expect(first.sourceApp).toBe('claude-desktop');
  expect(first.sourcePath).toBe('/Users/test/claude-desktop.log');
  expect(first.attempts).toBe(0);
  expect(first.sizeBytes).toBe(3);
  expect(first.bodyFormat).toBe('jsonl');
  expect(first.body).toEqual(new Uint8Array([9, 9, 9]));
});

test('queryPending orders by createdAt descending and filters', () => {
  const a = newBatch({ capturedAtUtc: '2026-05-01T00:00:00.000Z' });
  const b = newBatch({ capturedAtUtc: '2026-05-10T00:00:00.000Z' });
  insertBatch(db, a);
  insertBatch(db, b);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-01T00:00:00.000Z',
    a.captureId,
  ]);
  db.run('UPDATE upload_batches SET created_at = ? WHERE capture_id = ?', [
    '2026-05-03T00:00:00.000Z',
    b.captureId,
  ]);
  expect(queryPending(db, { limit: 1 }).map((r) => r.captureId)).toEqual([b.captureId]);
  expect(queryPending(db, { limit: 10, sourceApp: 'claude-code' })).toHaveLength(2);
  expect(queryPending(db, { limit: 10, sinceIso: '2026-05-05T00:00:00.000Z' })).toHaveLength(1);
});

test('queryByCaptureId returns null when nothing matches', () => {
  expect(queryByCaptureId(db, 'nope')).toBeNull();
});

test('queryByCaptureId finds an uploaded receipt by prefix', () => {
  const receipt = newReceipt({ userPrompt: 'hello' });
  insertReceipt(db, receipt);
  const found = queryByCaptureId(db, receipt.captureId.slice(0, 8));
  expect(found?.kind).toBe('uploaded');
  if (found?.kind === 'uploaded') expect(found.record.userPrompt).toBe('hello');
});

test('queryByCaptureId finds a failed batch', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  markBatchFailed(db, batch.captureId, 'boom');
  const found = queryByCaptureId(db, batch.captureId);
  expect(found?.kind).toBe('failed');
  if (found?.kind === 'failed') expect(found.record.lastError).toBe('boom');
});

test('queryByCaptureId finds a pending batch', () => {
  const batch = newBatch();
  insertBatch(db, batch);
  const found = queryByCaptureId(db, batch.captureId);
  expect(found?.kind).toBe('pending');
  if (found?.kind === 'pending') expect(found.record.captureId).toBe(batch.captureId);
});

test('queryByCaptureId prefers an uploaded receipt over a batch with the same id', () => {
  const id = generateUuidV7();
  insertReceipt(db, newReceipt({ captureId: id }));
  insertBatch(db, newBatch({ captureId: id }));
  expect(queryByCaptureId(db, id)?.kind).toBe('uploaded');
});
