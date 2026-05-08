import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { getDaemonState, openInMemoryBufferDb, setDaemonState } from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('getDaemonState returns null on a fresh buffer', () => {
  expect(getDaemonState(db)).toBeNull();
});

test('setDaemonState persists and getDaemonState round-trips', () => {
  setDaemonState(db, {
    lastCycleStartedAt: '2026-05-08T02:40:00Z',
    lastCycleCompletedAt: '2026-05-08T02:42:00Z',
    lastCycleDurationMs: 120000,
    lastDrainAttempted: 5,
    lastDrainAccepted: 4,
    lastDrainRetriable: 1,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: '503',
    lastConsecutiveRetriableBreak: false,
    lastSourceCaptures: {
      'claude-code': { filesProcessed: 1, capturedBatches: 2, capturedBytes: 100, errorsCount: 0 },
    },
  });
  const round = getDaemonState(db)!;
  expect(round.lastCycleStartedAt).toBe('2026-05-08T02:40:00Z');
  expect(round.lastDrainAttempted).toBe(5);
  expect(round.lastUploadError).toBe('503');
  expect(round.lastConsecutiveRetriableBreak).toBe(false);
  expect(round.lastSourceCaptures['claude-code']?.capturedBatches).toBe(2);
});

test('setDaemonState upserts (single row only)', () => {
  setDaemonState(db, {
    lastCycleStartedAt: 'a',
    lastCycleCompletedAt: 'b',
    lastCycleDurationMs: 1,
    lastDrainAttempted: 1,
    lastDrainAccepted: 1,
    lastDrainRetriable: 0,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: false,
    lastSourceCaptures: {},
  });
  setDaemonState(db, {
    lastCycleStartedAt: 'c',
    lastCycleCompletedAt: 'd',
    lastCycleDurationMs: 2,
    lastDrainAttempted: 2,
    lastDrainAccepted: 2,
    lastDrainRetriable: 0,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: 'oops',
    lastConsecutiveRetriableBreak: true,
    lastSourceCaptures: {},
  });
  const round = getDaemonState(db)!;
  expect(round.lastCycleStartedAt).toBe('c');
  expect(round.lastUploadError).toBe('oops');
  expect(round.lastConsecutiveRetriableBreak).toBe(true);
});

test('getDaemonState handles malformed JSON in source captures column gracefully', () => {
  setDaemonState(db, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });
  db.run("UPDATE daemon_state SET last_source_captures = '{not valid json' WHERE id = 1");
  const round = getDaemonState(db)!;
  expect(round.lastSourceCaptures).toEqual({});
});

test('getDaemonState handles non-object JSON in source captures column gracefully', () => {
  setDaemonState(db, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });
  db.run('UPDATE daemon_state SET last_source_captures = \'"a string"\' WHERE id = 1');
  const round = getDaemonState(db)!;
  expect(round.lastSourceCaptures).toEqual({});
});

test('getDaemonState handles null source captures column', () => {
  setDaemonState(db, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });
  db.run('UPDATE daemon_state SET last_source_captures = NULL WHERE id = 1');
  const round = getDaemonState(db)!;
  expect(round.lastSourceCaptures).toEqual({});
});

test('getDaemonState round-trips null consecutiveRetriableBreak as null', () => {
  setDaemonState(db, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });
  const round = getDaemonState(db)!;
  expect(round.lastConsecutiveRetriableBreak).toBeNull();
});
