import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  countQuarantined,
  openInMemoryBufferDb,
  pruneQuarantinedOlderThan,
  recordQuarantine,
} from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('recordQuarantine inserts a row that countQuarantined can read', () => {
  expect(countQuarantined(db)).toBe(0);
  recordQuarantine(db, {
    sourceApp: 'codex',
    sourcePath: '/tmp/state_5.sqlite',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkPosition: 42,
    rowPk: '42',
    redactedSizeBytes: 11_000_000,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    gatewayVersion: 'gw-0.1',
  });
  expect(countQuarantined(db)).toBe(1);
});

test('countQuarantined filters by sourceApp', () => {
  recordQuarantine(db, {
    sourceApp: 'codex',
    sourcePath: '/tmp/state.sqlite',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkPosition: 1,
    rowPk: null,
    redactedSizeBytes: 11_000_000,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    gatewayVersion: 'gw-0.1',
  });
  recordQuarantine(db, {
    sourceApp: 'cursor',
    sourcePath: '/tmp/state.vscdb',
    sourcePathHash: 'b'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
    watermarkPosition: 7,
    rowPk: '7',
    redactedSizeBytes: 12_000_000,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:43.000Z',
    gatewayVersion: 'gw-0.1',
  });
  expect(countQuarantined(db)).toBe(2);
  expect(countQuarantined(db, 'codex')).toBe(1);
  expect(countQuarantined(db, 'cursor')).toBe(1);
  expect(countQuarantined(db, 'claude-code')).toBe(0);
});

test('pruneQuarantinedOlderThan deletes records strictly older than the cutoff', () => {
  recordQuarantine(db, {
    sourceApp: 'codex',
    sourcePath: '/old',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkPosition: 1,
    rowPk: '1',
    redactedSizeBytes: 1,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2025-01-01T00:00:00.000Z',
    gatewayVersion: 'gw-0.1',
  });
  recordQuarantine(db, {
    sourceApp: 'codex',
    sourcePath: '/new',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkPosition: 2,
    rowPk: '2',
    redactedSizeBytes: 2,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    gatewayVersion: 'gw-0.1',
  });
  const removed = pruneQuarantinedOlderThan(db, '2026-01-01T00:00:00.000Z');
  expect(removed).toBe(1);
  expect(countQuarantined(db)).toBe(1);
});

test('pruneQuarantinedOlderThan returns 0 when nothing is older', () => {
  recordQuarantine(db, {
    sourceApp: 'cursor',
    sourcePath: '/p',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: null,
    watermarkTable: null,
    watermarkPosition: 1,
    rowPk: '1',
    redactedSizeBytes: 1,
    reason: 'oversized_decompressed',
    quarantinedAtUtc: '2026-05-08T13:25:42.000Z',
    gatewayVersion: 'gw-0.1',
  });
  const removed = pruneQuarantinedOlderThan(db, '2026-01-01T00:00:00.000Z');
  expect(removed).toBe(0);
  expect(countQuarantined(db)).toBe(1);
});
