import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';

import { openInMemoryBufferDb, setMetadata } from 'services/buffer';
import {
  getMetadataWithFallback,
  readNumber,
  readNumberOrNull,
  readNumberWithFallback,
} from 'services/buffer/metadata-readers.ts';

let db: SqliteDatabase;
beforeEach(() => {
  db = openInMemoryBufferDb();
});
afterEach(() => {
  db.close();
});

test('readNumber: returns 0 when key absent', () => {
  expect(readNumber(db, 'nope')).toBe(0);
});

test('readNumber: returns 0 when value is non-numeric', () => {
  setMetadata(db, 'k', 'banana');
  expect(readNumber(db, 'k')).toBe(0);
});

test('readNumber: parses numeric value', () => {
  setMetadata(db, 'k', '42');
  expect(readNumber(db, 'k')).toBe(42);
});

test('readNumberOrNull: null when key absent', () => {
  expect(readNumberOrNull(db, 'nope')).toBe(null);
});

test('readNumberOrNull: null when non-numeric', () => {
  setMetadata(db, 'k', 'banana');
  expect(readNumberOrNull(db, 'k')).toBe(null);
});

test('readNumberOrNull: parses numeric value', () => {
  setMetadata(db, 'k', '99');
  expect(readNumberOrNull(db, 'k')).toBe(99);
});

test('readNumberWithFallback: prefers primary when set', () => {
  setMetadata(db, 'p', '5');
  setMetadata(db, 'l', '99');
  expect(readNumberWithFallback(db, 'p', 'l')).toBe(5);
});

test('readNumberWithFallback: falls back to legacy when primary absent', () => {
  setMetadata(db, 'l', '99');
  expect(readNumberWithFallback(db, 'p', 'l')).toBe(99);
});

test('readNumberWithFallback: falls back when primary is non-numeric', () => {
  setMetadata(db, 'p', 'NaN-value');
  setMetadata(db, 'l', '7');
  expect(readNumberWithFallback(db, 'p', 'l')).toBe(7);
});

test('readNumberWithFallback: returns 0 when both absent', () => {
  expect(readNumberWithFallback(db, 'p', 'l')).toBe(0);
});

test('getMetadataWithFallback: prefers primary', () => {
  setMetadata(db, 'p', 'primary');
  setMetadata(db, 'l', 'legacy');
  expect(getMetadataWithFallback(db, 'p', 'l')).toBe('primary');
});

test('getMetadataWithFallback: falls back to legacy', () => {
  setMetadata(db, 'l', 'legacy');
  expect(getMetadataWithFallback(db, 'p', 'l')).toBe('legacy');
});

test('getMetadataWithFallback: returns null when both absent', () => {
  expect(getMetadataWithFallback(db, 'p', 'l')).toBe(null);
});

test('getMetadataWithFallback: legacy=null skips fallback when primary absent', () => {
  expect(getMetadataWithFallback(db, 'p', null)).toBe(null);
});
