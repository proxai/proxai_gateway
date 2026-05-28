import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { requireDefined } from 'core/utils';
import {
  countResyncEvents,
  openInMemoryBufferDb,
  recentResyncEvents,
  recordResyncEvent,
} from 'services/buffer';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('countResyncEvents returns 0 when no events are recorded', () => {
  expect(countResyncEvents(db)).toBe(0);
});

test('recentResyncEvents returns an empty array when no events are recorded', () => {
  expect(recentResyncEvents(db, 10)).toEqual([]);
});

test('recordResyncEvent inserts an event and countResyncEvents returns 1', () => {
  const event = {
    sourceApp: 'claude-code' as const,
    sourcePathHash: 'abc123hash',
    watermarkKind: 'rowid_range' as const,
    serverWatermarkEnd: 100,
    skippedUnits: 5,
    recoveredAt: '2026-05-28T04:42:42Z',
  };

  recordResyncEvent(db, event);

  expect(countResyncEvents(db)).toBe(1);

  const recent = recentResyncEvents(db, 10);
  expect(recent).toHaveLength(1);

  const first = requireDefined(recent[0]);
  expect(first.id).toBe(1);
  expect(first.sourceApp).toBe('claude-code');
  expect(first.sourcePathHash).toBe('abc123hash');
  expect(first.watermarkKind).toBe('rowid_range');
  expect(first.serverWatermarkEnd).toBe(100);
  expect(first.skippedUnits).toBe(5);
  expect(first.recoveredAt).toBe('2026-05-28T04:42:42Z');
});

test('recentResyncEvents returns events sorted by recoveredAt descending and respects limit', () => {
  const event1 = {
    sourceApp: 'claude-code' as const,
    sourcePathHash: 'hash1',
    watermarkKind: 'rowid_range' as const,
    serverWatermarkEnd: 10,
    skippedUnits: 1,
    recoveredAt: '2026-05-28T01:00:00Z',
  };

  const event2 = {
    sourceApp: 'cursor' as const,
    sourcePathHash: 'hash2',
    watermarkKind: 'rowid_range' as const,
    serverWatermarkEnd: 20,
    skippedUnits: 2,
    recoveredAt: '2026-05-28T03:00:00Z',
  };

  const event3 = {
    sourceApp: 'gemini-cli' as const,
    sourcePathHash: 'hash3',
    watermarkKind: 'rowid_range' as const,
    serverWatermarkEnd: 30,
    skippedUnits: 3,
    recoveredAt: '2026-05-28T02:00:00Z',
  };

  recordResyncEvent(db, event1);
  recordResyncEvent(db, event2);
  recordResyncEvent(db, event3);

  expect(countResyncEvents(db)).toBe(3);

  const allRecent = recentResyncEvents(db, 10);
  expect(allRecent).toHaveLength(3);
  expect(requireDefined(allRecent[0]).sourceApp).toBe('cursor');
  expect(requireDefined(allRecent[1]).sourceApp).toBe('gemini-cli');
  expect(requireDefined(allRecent[2]).sourceApp).toBe('claude-code');

  const limitedRecent = recentResyncEvents(db, 2);
  expect(limitedRecent).toHaveLength(2);
  expect(requireDefined(limitedRecent[0]).sourceApp).toBe('cursor');
  expect(requireDefined(limitedRecent[1]).sourceApp).toBe('gemini-cli');
});
