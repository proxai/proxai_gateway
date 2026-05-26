import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBufferDb } from 'services/buffer';
import {
  buildSnapshot,
  loadSnapshotRegistry,
  parseSnapshotRegistry,
  persistSnapshotRegistry,
  serializeSnapshotRegistry,
} from 'services/state-machines/snapshot';

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-snapshot-'));
  dbPath = join(dir, 'buffer.db');
  db = openBufferDb(dbPath);
});

afterEach(async () => {
  db.close();
  await rmRecursive(dir);
});

test('parseSnapshotRegistry returns empty object for null', () => {
  expect(parseSnapshotRegistry(null)).toEqual({});
});

test('parseSnapshotRegistry returns empty object for empty string', () => {
  expect(parseSnapshotRegistry('')).toEqual({});
});

test('parseSnapshotRegistry returns empty object for malformed JSON', () => {
  expect(parseSnapshotRegistry('not json')).toEqual({});
});

test('parseSnapshotRegistry returns empty object for JSON array (not an object)', () => {
  expect(parseSnapshotRegistry('[]')).toEqual({});
});

test('serializeSnapshotRegistry and parseSnapshotRegistry roundtrip', () => {
  const original = {
    'binary-freshness': buildSnapshot('fresh', { days: 10 }, 'active', '2026-05-25T12:00:00.000Z'),
  };
  const json = serializeSnapshotRegistry(original);
  const back = parseSnapshotRegistry(json);
  expect(back).toEqual(original);
});

test('persistSnapshotRegistry and loadSnapshotRegistry roundtrip via SQLite', () => {
  const original = {
    'capture-loop': buildSnapshot('waiting', { cycles: 5 }, 'active', '2026-05-25T12:00:00.000Z'),
    'drain-loop': buildSnapshot('draining', { cycles: 3 }, 'active', '2026-05-25T12:00:01.000Z'),
  };
  persistSnapshotRegistry(db, original);
  expect(loadSnapshotRegistry(db)).toEqual(original);
});

test('loadSnapshotRegistry returns empty when no row exists', () => {
  expect(loadSnapshotRegistry(db)).toEqual({});
});

test('persistSnapshotRegistry overwrites prior values', () => {
  persistSnapshotRegistry(db, {
    'capture-loop': buildSnapshot('a', {}, 'active', '2026-05-25T12:00:00.000Z'),
  });
  persistSnapshotRegistry(db, {
    'capture-loop': buildSnapshot('b', {}, 'active', '2026-05-25T12:00:01.000Z'),
  });
  const loaded = loadSnapshotRegistry(db);
  expect(loaded['capture-loop']?.value).toBe('b');
});
