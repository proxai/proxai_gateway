import { expect, test } from 'bun:test';

import { parseBackfillDuration } from 'core/utils';

const DAY_MS = 24 * 60 * 60 * 1000;

test('parses days', () => {
  expect(parseBackfillDuration('1d')).toBe(DAY_MS);
  expect(parseBackfillDuration('30d')).toBe(30 * DAY_MS);
  expect(parseBackfillDuration('365d')).toBe(365 * DAY_MS);
});

test('parses months as 30-day approximations', () => {
  expect(parseBackfillDuration('1mo')).toBe(30 * DAY_MS);
  expect(parseBackfillDuration('6mo')).toBe(180 * DAY_MS);
});

test('parses years as 365-day approximations', () => {
  expect(parseBackfillDuration('1y')).toBe(365 * DAY_MS);
  expect(parseBackfillDuration('2y')).toBe(730 * DAY_MS);
});

test('accepts 0d (zero duration)', () => {
  expect(parseBackfillDuration('0d')).toBe(0);
});

test('trims surrounding whitespace', () => {
  expect(parseBackfillDuration('  7d  ')).toBe(7 * DAY_MS);
});

test('rejects ambiguous "Nm" (could be minutes or months)', () => {
  expect(parseBackfillDuration('1m')).toBeNull();
  expect(parseBackfillDuration('30m')).toBeNull();
});

test('rejects sub-day units like seconds and minutes', () => {
  expect(parseBackfillDuration('60s')).toBeNull();
  expect(parseBackfillDuration('24h')).toBeNull();
});

test('rejects malformed inputs', () => {
  expect(parseBackfillDuration('')).toBeNull();
  expect(parseBackfillDuration('d')).toBeNull();
  expect(parseBackfillDuration('30')).toBeNull();
  expect(parseBackfillDuration('1.5d')).toBeNull();
  expect(parseBackfillDuration('-7d')).toBeNull();
  expect(parseBackfillDuration('thirty days')).toBeNull();
  expect(parseBackfillDuration('1week')).toBeNull();
});
