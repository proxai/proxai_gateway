import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { generateUuidV7, nowIsoUtc, requireDefined } from 'core/utils';
import { gatherLogsFrame } from 'cli/commands/logs/gather-records.ts';
import type { NewBatch, QuarantineRecordInput } from 'services/buffer';
import {
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
  recordQuarantine,
} from 'services/buffer';

let buffer: Database;

beforeEach(() => {
  buffer = openInMemoryBufferDb();
});

afterEach(() => {
  buffer.close();
});

function makeBatch(overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/home/user/project/session.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 42,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: 100,
    watermarkTable: null,
    agentSchemaVersion: 'claude-code/1.0.0',
    gatewayVersion: '2026.5.28',
    capturedAtUtc: nowIsoUtc(),
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

function seedDelivered(overrides: Partial<NewBatch> = {}): string {
  const batch = makeBatch(overrides);
  insertBatch(buffer, batch);
  const stored = getBatch(buffer, batch.captureId);
  markBatchDelivered(buffer, requireDefined(stored), { idempotentOnServer: false });
  return batch.captureId;
}

function seedFailed(overrides: Partial<NewBatch> = {}): string {
  const batch = makeBatch(overrides);
  insertBatch(buffer, batch);
  markBatchFailed(buffer, batch.captureId, 'server returned 500');
  return batch.captureId;
}

function seedPending(overrides: Partial<NewBatch> = {}): string {
  const batch = makeBatch(overrides);
  insertBatch(buffer, batch);
  return batch.captureId;
}

function makeQuarantine(overrides: Partial<QuarantineRecordInput> = {}): QuarantineRecordInput {
  return {
    sourceApp: 'cursor',
    sourcePath: '/home/user/project/state.vscdb',
    sourcePathHash: 'b'.repeat(64),
    sourceInode: 7,
    watermarkTable: null,
    watermarkPosition: 5,
    rowPk: null,
    redactedSizeBytes: 3 * 1024 * 1024,
    reason: 'oversized',
    quarantinedAtUtc: nowIsoUtc(),
    gatewayVersion: '2026.5.28',
    ...overrides,
  };
}

test('default frame pulls only uploaded receipts', () => {
  const id = seedDelivered();
  seedFailed();
  const frame = gatherLogsFrame(buffer, {});
  expect(frame.uploaded).toHaveLength(1);
  expect(frame.uploaded[0]?.captureId).toBe(id);
  expect(frame.failed).toEqual([]);
  expect(frame.quarantined).toEqual([]);
  expect(frame.pending).toEqual([]);
});

test('error frame pulls failed batches and quarantined records', () => {
  seedFailed();
  recordQuarantine(buffer, makeQuarantine());
  const frame = gatherLogsFrame(buffer, { error: true });
  expect(frame.uploaded).toEqual([]);
  expect(frame.failed).toHaveLength(1);
  expect(frame.failed[0]?.lastError).toBe('server returned 500');
  expect(frame.quarantined).toHaveLength(1);
  expect(frame.quarantined[0]?.reason).toBe('oversized');
  expect(frame.pending).toEqual([]);
});

test('pending frame pulls only pending batches', () => {
  const id = seedPending();
  seedDelivered();
  const frame = gatherLogsFrame(buffer, { pending: true });
  expect(frame.pending).toHaveLength(1);
  expect(frame.pending[0]?.captureId).toBe(id);
  expect(frame.uploaded).toEqual([]);
  expect(frame.failed).toEqual([]);
  expect(frame.quarantined).toEqual([]);
});

test('source filter narrows uploaded results to the requested app', () => {
  seedDelivered({ sourceApp: 'claude-code' });
  seedDelivered({ sourceApp: 'codex', sourceKind: 'jsonl_append', sourcePathHash: 'c'.repeat(64) });
  const frame = gatherLogsFrame(buffer, { source: 'codex' });
  expect(frame.uploaded).toHaveLength(1);
  expect(frame.uploaded[0]?.sourceApp).toBe('codex');
});

test('limit option caps the number of returned rows', () => {
  seedDelivered();
  seedDelivered({ sourcePathHash: 'd'.repeat(64) });
  seedDelivered({ sourcePathHash: 'e'.repeat(64) });
  const frame = gatherLogsFrame(buffer, { lines: 2 });
  expect(frame.uploaded).toHaveLength(2);
});

test('valid since duration filters by recent delivery window', () => {
  seedDelivered();
  const frame = gatherLogsFrame(buffer, { since: '1h' });
  expect(frame.uploaded).toHaveLength(1);
});

test('invalid since duration is ignored and returns all rows', () => {
  seedDelivered();
  const frame = gatherLogsFrame(buffer, { since: 'not-a-duration' });
  expect(frame.uploaded).toHaveLength(1);
});
