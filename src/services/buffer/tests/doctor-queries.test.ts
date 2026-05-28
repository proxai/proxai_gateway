import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireDefined } from 'core/utils';
import {
  BUFFER_TABLES,
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openBufferDb,
  openInMemoryBufferDb,
  recordResyncEvent,
  setDaemonState,
  setMetadata,
} from 'services/buffer';
import type { DaemonStateSnapshot } from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';
import {
  checkReceiptsTableReadable,
  queryAllDoctorData,
  queryDoctorBufferStats,
  queryDoctorDaemonState,
  queryDoctorRecentEvents,
  queryDoctorResyncStats,
  tableExists,
} from 'services/buffer/doctor-queries.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

function fullDaemonState(overrides: Partial<DaemonStateSnapshot> = {}): DaemonStateSnapshot {
  const base: DaemonStateSnapshot = {
    lastCycleStartedAt: '2026-05-28T10:00:00.000Z',
    lastCycleCompletedAt: '2026-05-28T10:01:00.000Z',
    lastCycleDurationMs: 60000,
    lastDrainAttempted: 1,
    lastDrainAccepted: 1,
    lastDrainRetriable: 0,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  };
  return { ...base, ...overrides };
}

test('queryDoctorBufferStats returns zeroed stats for an empty buffer', () => {
  const stats = queryDoctorBufferStats(db);
  expect(stats).toEqual({
    pendingCount: 0,
    pendingBytes: 0,
    failedCount: 0,
    quarantinedCount: 0,
    receiptCount: 0,
    lastPruneAt: null,
    lastSuccessAt: null,
  });
});

test('queryDoctorBufferStats aggregates pending failed receipts and metadata', () => {
  const pendingA = newBatch({ body: new Uint8Array(100) });
  const pendingB = newBatch({ body: new Uint8Array(200) });
  const toFail = newBatch({ body: new Uint8Array(50) });
  const toDeliver = newBatch({ body: new Uint8Array(10) });
  insertBatch(db, pendingA);
  insertBatch(db, pendingB);
  insertBatch(db, toFail);
  insertBatch(db, toDeliver);
  markBatchFailed(db, toFail.captureId, 'boom');
  markBatchDelivered(db, requireDefined(getBatch(db, toDeliver.captureId)), {
    idempotentOnServer: false,
  });

  db.run(
    'INSERT INTO quarantined_records (source_app, source_path, source_path_hash, watermark_position, redacted_size_bytes, reason, quarantined_at_utc, gateway_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'claude-code',
      '/Users/test/.claude/session.jsonl',
      'a'.repeat(64),
      0,
      9999,
      'oversize',
      '2026-05-28T09:00:00.000Z',
      '@proxai/gateway 0.1.0',
    ],
  );

  setMetadata(db, 'last_prune_at', '2026-05-28T08:00:00.000Z');
  setMetadata(db, 'upload_last_success_at', '2026-05-28T08:30:00.000Z');

  const stats = queryDoctorBufferStats(db);
  expect(stats.pendingCount).toBe(2);
  expect(stats.pendingBytes).toBe(300);
  expect(stats.failedCount).toBe(1);
  expect(stats.quarantinedCount).toBe(1);
  expect(stats.receiptCount).toBe(1);
  expect(stats.lastPruneAt).toBe('2026-05-28T08:00:00.000Z');
  expect(stats.lastSuccessAt).toBe('2026-05-28T08:30:00.000Z');
});

test('queryDoctorDaemonState returns nulls when daemon_state and metadata are absent', () => {
  const state = queryDoctorDaemonState(db);
  expect(state).toEqual({
    captureLastCycleAt: null,
    drainLastCycleAt: null,
    lastConsecutiveRetriableBreak: null,
  });
});

test('queryDoctorDaemonState reads cycle metadata and a true retriable break', () => {
  setMetadata(db, 'capture_last_cycle_at', '2026-05-28T10:05:00.000Z');
  setMetadata(db, 'drain_last_cycle_at', '2026-05-28T10:06:00.000Z');
  setDaemonState(db, fullDaemonState({ lastConsecutiveRetriableBreak: true }));

  const state = queryDoctorDaemonState(db);
  expect(state.captureLastCycleAt).toBe('2026-05-28T10:05:00.000Z');
  expect(state.drainLastCycleAt).toBe('2026-05-28T10:06:00.000Z');
  expect(state.lastConsecutiveRetriableBreak).toBe(true);
});

test('queryDoctorDaemonState reports a false retriable break', () => {
  setDaemonState(db, fullDaemonState({ lastConsecutiveRetriableBreak: false }));
  const state = queryDoctorDaemonState(db);
  expect(state.lastConsecutiveRetriableBreak).toBe(false);
});

test('queryDoctorDaemonState keeps a null retriable break when daemon_state stores null', () => {
  setDaemonState(db, fullDaemonState({ lastConsecutiveRetriableBreak: null }));
  const state = queryDoctorDaemonState(db);
  expect(state.lastConsecutiveRetriableBreak).toBeNull();
});

test('queryDoctorRecentEvents returns empty counts when no failed batches exist', () => {
  const events = queryDoctorRecentEvents(db);
  expect(events).toEqual({
    authUnconfirmedCount: 0,
    rateLimitedCount: 0,
    retriableCount: 0,
    fatalValidationErrorCount: 0,
    autoUpgradeEvents: [],
    failedBatchLastErrors: [],
  });
});

test('queryDoctorRecentEvents classifies each failed-batch error category', () => {
  const cases: readonly string[] = [
    'AUTH_UNCONFIRMED key not verified',
    'auth unconfirmed retrying',
    'server returned rate limit hit',
    'ValidationError: bad DTO',
    'fatal validation error in payload',
    'retriable network blip',
    'AUTO_UPGRADE pending new binary',
    'upgrade available now',
    'some other unclassified failure',
  ];
  for (const message of cases) {
    const b = newBatch();
    insertBatch(db, b);
    markBatchFailed(db, b.captureId, message);
  }

  const events = queryDoctorRecentEvents(db);
  expect(events.authUnconfirmedCount).toBe(2);
  expect(events.rateLimitedCount).toBe(1);
  expect(events.fatalValidationErrorCount).toBe(2);
  expect(events.retriableCount).toBe(1);
  expect(events.autoUpgradeEvents.length).toBe(2);
  expect(events.autoUpgradeEvents).toContain('AUTO_UPGRADE pending new binary');
  expect(events.autoUpgradeEvents).toContain('upgrade available now');
  expect(events.failedBatchLastErrors.length).toBe(9);
});

test('queryDoctorRecentEvents skips failed batches whose error is an empty string', () => {
  const b = newBatch();
  insertBatch(db, b);
  markBatchFailed(db, b.captureId, '');

  const events = queryDoctorRecentEvents(db);
  expect(events.failedBatchLastErrors).toEqual([]);
  expect(events.authUnconfirmedCount).toBe(0);
});

test('queryDoctorResyncStats returns zero when no resync events recorded', () => {
  const stats = queryDoctorResyncStats(db);
  expect(stats).toEqual({ totalCount: 0, regressionLoops: [] });
});

test('queryDoctorResyncStats counts events and flags regression loops over threshold', () => {
  const loopingHash = 'b'.repeat(64);
  const quietHash = 'c'.repeat(64);
  const recentIso = new Date().toISOString();

  for (let i = 0; i < 4; i++) {
    recordResyncEvent(db, {
      sourceApp: 'claude-code',
      sourcePathHash: loopingHash,
      watermarkKind: 'byte_range',
      serverWatermarkEnd: 1000 + i,
      skippedUnits: 5,
      recoveredAt: recentIso,
    });
  }
  recordResyncEvent(db, {
    sourceApp: 'cursor',
    sourcePathHash: quietHash,
    watermarkKind: 'rowid_range',
    serverWatermarkEnd: 42,
    skippedUnits: 1,
    recoveredAt: recentIso,
  });

  const stats = queryDoctorResyncStats(db);
  expect(stats.totalCount).toBe(5);
  expect(stats.regressionLoops).toEqual([{ sourcePathHash: loopingHash, countInLastHour: 4 }]);
});

test('queryDoctorResyncStats ignores stale events outside the one-hour window', () => {
  const loopingHash = 'd'.repeat(64);
  const staleIso = '2020-01-01T00:00:00.000Z';
  for (let i = 0; i < 5; i++) {
    recordResyncEvent(db, {
      sourceApp: 'claude-code',
      sourcePathHash: loopingHash,
      watermarkKind: 'byte_range',
      serverWatermarkEnd: 100 + i,
      skippedUnits: 2,
      recoveredAt: staleIso,
    });
  }

  const stats = queryDoctorResyncStats(db);
  expect(stats.totalCount).toBe(5);
  expect(stats.regressionLoops).toEqual([]);
});

test('queryDoctorResyncStats returns the empty default when resync_events table is missing', () => {
  db.run(`DROP TABLE ${BUFFER_TABLES.resyncEvents}`);
  const stats = queryDoctorResyncStats(db);
  expect(stats).toEqual({ totalCount: 0, regressionLoops: [] });
});

test('tableExists reports true for present tables and false for absent ones', () => {
  expect(tableExists(db, BUFFER_TABLES.batches)).toBe(true);
  expect(tableExists(db, 'a_table_that_was_never_created')).toBe(false);
});

test('tableExists returns false when the query throws on a closed database', () => {
  const closable = openInMemoryBufferDb();
  closable.close();
  expect(tableExists(closable, BUFFER_TABLES.batches)).toBe(false);
});

test('checkReceiptsTableReadable returns true when the receipts table is queryable', () => {
  expect(checkReceiptsTableReadable(db)).toBe(true);
});

test('checkReceiptsTableReadable returns false when the receipts table is dropped', () => {
  db.run(`DROP TABLE ${BUFFER_TABLES.receipts}`);
  expect(checkReceiptsTableReadable(db)).toBe(false);
});

test('queryAllDoctorData returns all-empty defaults when the database file cannot be opened', () => {
  const result = queryAllDoctorData(join(tmpdir(), 'proxai-doctor-nonexistent-file.db'));
  expect(result.bufferStats.pendingCount).toBe(0);
  expect(result.bufferStats.receiptCount).toBe(0);
  expect(result.daemonState.captureLastCycleAt).toBeNull();
  expect(result.recentEvents.failedBatchLastErrors).toEqual([]);
  expect(result.resyncStats.totalCount).toBe(0);
});

test('queryAllDoctorData reads a fully seeded buffer database by file path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-doctor-all-'));
  try {
    const path = join(dir, 'buffer.db');
    const seed = openBufferDb(path);
    try {
      const pending = newBatch({ body: new Uint8Array(128) });
      const failed = newBatch();
      insertBatch(seed, pending);
      insertBatch(seed, failed);
      markBatchFailed(seed, failed.captureId, 'retriable network blip');
      setMetadata(seed, 'capture_last_cycle_at', '2026-05-28T10:05:00.000Z');
      setMetadata(seed, 'drain_last_cycle_at', '2026-05-28T10:06:00.000Z');
      setMetadata(seed, 'upload_last_success_at', '2026-05-28T08:30:00.000Z');
      setDaemonState(seed, fullDaemonState({ lastConsecutiveRetriableBreak: true }));
      recordResyncEvent(seed, {
        sourceApp: 'claude-code',
        sourcePathHash: 'e'.repeat(64),
        watermarkKind: 'byte_range',
        serverWatermarkEnd: 500,
        skippedUnits: 3,
        recoveredAt: new Date().toISOString(),
      });
    } finally {
      seed.close();
    }

    const result = queryAllDoctorData(path);
    expect(result.bufferStats.pendingCount).toBe(1);
    expect(result.bufferStats.pendingBytes).toBe(128);
    expect(result.bufferStats.failedCount).toBe(1);
    expect(result.daemonState.captureLastCycleAt).toBe('2026-05-28T10:05:00.000Z');
    expect(result.daemonState.drainLastCycleAt).toBe('2026-05-28T10:06:00.000Z');
    expect(result.daemonState.lastConsecutiveRetriableBreak).toBe(true);
    expect(result.recentEvents.retriableCount).toBe(1);
    expect(result.recentEvents.failedBatchLastErrors).toEqual(['retriable network blip']);
    expect(result.resyncStats.totalCount).toBe(1);
  } finally {
    await rmRecursive(dir);
  }
}, 30_000);

test('queryAllDoctorData swallows per-query failures when core tables are missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-doctor-broken-'));
  try {
    const path = join(dir, 'buffer.db');
    const seed = openBufferDb(path);
    try {
      seed.run(`DROP TABLE ${BUFFER_TABLES.batches}`);
      seed.run(`DROP TABLE ${BUFFER_TABLES.daemonState}`);
      seed.run(`DROP TABLE ${BUFFER_TABLES.receipts}`);
      seed.run(`DROP TABLE ${BUFFER_TABLES.resyncEvents}`);
    } finally {
      seed.close();
    }

    const result = queryAllDoctorData(path);
    expect(result.bufferStats.pendingCount).toBe(0);
    expect(result.daemonState.captureLastCycleAt).toBeNull();
    expect(result.recentEvents.failedBatchLastErrors).toEqual([]);
    expect(result.resyncStats.totalCount).toBe(0);
  } finally {
    await rmRecursive(dir);
  }
}, 30_000);
