import { expect, test } from 'bun:test';

import {
  compareDates,
  compareVersions,
  computeNextVersion,
  formatVersion,
  parseVersion,
  pickLatestTag,
  todayUtc,
  type Version,
} from 'scripts/release/versioning.ts';

const v = (year: number, month: number, day: number, suffix: number | null = null): Version => ({
  year,
  month,
  day,
  suffix,
});

test('parseVersion accepts vYYYY.M.D', () => {
  expect(parseVersion('v2026.5.8')).toEqual(v(2026, 5, 8, null));
});

test('parseVersion accepts bare YYYY.M.D (no v)', () => {
  expect(parseVersion('2026.5.8')).toEqual(v(2026, 5, 8, null));
});

test('parseVersion accepts vYYYY.M.D-N', () => {
  expect(parseVersion('v2026.5.8-3')).toEqual(v(2026, 5, 8, 3));
});

test('parseVersion accepts multi-digit components', () => {
  expect(parseVersion('v2026.10.31-15')).toEqual(v(2026, 10, 31, 15));
});

test('parseVersion returns null on malformed', () => {
  expect(parseVersion('not-a-version')).toBeNull();
  expect(parseVersion('v2026.5')).toBeNull();
  expect(parseVersion('v2026.5.x')).toBeNull();
  expect(parseVersion('v2026.5.8-')).toBeNull();
  expect(parseVersion('v2026.5.8-abc')).toBeNull();
});

test('formatVersion produces YYYY.M.D for null suffix', () => {
  expect(formatVersion(v(2026, 5, 8, null))).toBe('2026.5.8');
});

test('formatVersion produces YYYY.M.D-N for integer suffix', () => {
  expect(formatVersion(v(2026, 5, 8, 3))).toBe('2026.5.8-3');
});

test('compareDates orders by year then month then day', () => {
  expect(compareDates(v(2026, 5, 8), v(2026, 5, 9))).toBeLessThan(0);
  expect(compareDates(v(2026, 5, 9), v(2026, 5, 8))).toBeGreaterThan(0);
  expect(compareDates(v(2026, 5, 8), v(2026, 5, 8))).toBe(0);
  expect(compareDates(v(2026, 4, 30), v(2026, 5, 1))).toBeLessThan(0);
  expect(compareDates(v(2025, 12, 31), v(2026, 1, 1))).toBeLessThan(0);
});

test('compareDates ignores suffixes', () => {
  expect(compareDates(v(2026, 5, 8, 5), v(2026, 5, 8, null))).toBe(0);
});

test('compareVersions: same date, null suffix < integer suffix', () => {
  expect(compareVersions(v(2026, 5, 8, null), v(2026, 5, 8, 1))).toBeLessThan(0);
});

test('compareVersions: same date, suffix integer order', () => {
  expect(compareVersions(v(2026, 5, 8, 1), v(2026, 5, 8, 2))).toBeLessThan(0);
});

test('compareVersions: different dates dominate suffix', () => {
  expect(compareVersions(v(2026, 5, 8, 9), v(2026, 5, 9, null))).toBeLessThan(0);
});

test('todayUtc returns UTC components from a fixed date', () => {
  const fixed = new Date('2026-05-08T03:14:00Z');
  expect(todayUtc(fixed)).toEqual(v(2026, 5, 8, null));
});

test('todayUtc handles year boundary in UTC', () => {
  const fixed = new Date('2027-01-01T00:00:00Z');
  expect(todayUtc(fixed)).toEqual(v(2027, 1, 1, null));
});

test('todayUtc default uses Date constructor', () => {
  const result = todayUtc();
  expect(result.year).toBeGreaterThan(2000);
  expect(result.month).toBeGreaterThanOrEqual(1);
  expect(result.month).toBeLessThanOrEqual(12);
  expect(result.day).toBeGreaterThanOrEqual(1);
  expect(result.day).toBeLessThanOrEqual(31);
  expect(result.suffix).toBeNull();
});

test('pickLatestTag returns null when none parse', () => {
  expect(pickLatestTag([])).toBeNull();
  expect(pickLatestTag(['junk', 'also-junk'])).toBeNull();
});

test('pickLatestTag returns the highest by date+suffix', () => {
  const tags = ['v2026.5.7', 'v2026.5.8', 'v2026.5.8-1', 'v2026.5.8-2', 'junk', 'v2026.5.6'];
  expect(pickLatestTag(tags)).toEqual(v(2026, 5, 8, 2));
});

test('pickLatestTag treats null suffix < integer suffix on same day', () => {
  const tags = ['v2026.5.8', 'v2026.5.8-1'];
  expect(pickLatestTag(tags)).toEqual(v(2026, 5, 8, 1));
});

test('pickLatestTag returns single valid tag from mixed input', () => {
  expect(pickLatestTag(['v2026.5.8', 'malformed'])).toEqual(v(2026, 5, 8, null));
});

test('computeNextVersion: no prior tags → today with no suffix', () => {
  expect(computeNextVersion(null, v(2026, 5, 8))).toEqual(v(2026, 5, 8, null));
});

test('computeNextVersion: latest before today → today with no suffix', () => {
  expect(computeNextVersion(v(2026, 5, 7, 3), v(2026, 5, 8))).toEqual(v(2026, 5, 8, null));
});

test('computeNextVersion: latest on today (no suffix) → today-1', () => {
  expect(computeNextVersion(v(2026, 5, 8, null), v(2026, 5, 8))).toEqual(v(2026, 5, 8, 1));
});

test('computeNextVersion: latest on today (suffix 3) → today-4', () => {
  expect(computeNextVersion(v(2026, 5, 8, 3), v(2026, 5, 8))).toEqual(v(2026, 5, 8, 4));
});

test('computeNextVersion: latest ahead of today → bump suffix on latest, do NOT advance date', () => {
  expect(computeNextVersion(v(2026, 5, 10, null), v(2026, 5, 8))).toEqual(v(2026, 5, 10, 1));
});

test('computeNextVersion: latest ahead of today with existing suffix → suffix+1 on latest', () => {
  expect(computeNextVersion(v(2026, 5, 10, 2), v(2026, 5, 8))).toEqual(v(2026, 5, 10, 3));
});

test('computeNextVersion: latest ahead by month/year → still bump suffix on latest', () => {
  expect(computeNextVersion(v(2027, 1, 1, null), v(2026, 5, 8))).toEqual(v(2027, 1, 1, 1));
});
