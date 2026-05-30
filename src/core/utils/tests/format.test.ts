import { expect, test } from 'bun:test';
import {
  formatLocalTimestamp,
  formatRelative,
  formatTimeWithRelative,
  formatBytes,
  formatDuration,
  formatPercent,
} from '../format.ts';

test('formatLocalTimestamp formats ISO strings correctly', () => {
  const ts = '2026-05-20T20:30:00.000Z';

  const result = formatLocalTimestamp(ts, { timeZone: 'UTC' });
  expect(result).toBe('20 May 20:30:00');

  expect(formatLocalTimestamp('invalid-date')).toBe('invalid-date');
});

test('monthFromIso fallback works', () => {
  const ts = '2026-05-20T20:30:00.000Z';

  const result = formatLocalTimestamp(ts, { locale: 'xx-XX', timeZone: 'UTC' });
  expect(result).toContain('May');
});

test('monthFromIso is used when locale produces a non-English month name', () => {
  const ts = '2026-05-20T20:30:00.000Z';

  const result = formatLocalTimestamp(ts, { locale: 'fr-FR', timeZone: 'UTC' });
  expect(result).toContain('May');
});

test('formatRelative returns relative string', () => {
  const base = new Date('2026-05-20T20:30:00.000Z');

  expect(formatRelative('2026-05-20T20:29:55.000Z', { now: base })).toBe('5s ago');
  expect(formatRelative('2026-05-20T20:25:00.000Z', { now: base })).toBe('5 min ago');
  expect(formatRelative('2026-05-20T18:30:00.000Z', { now: base })).toBe('2 h ago');
  expect(formatRelative('2026-05-18T20:30:00.000Z', { now: base })).toBe('2 d ago');

  expect(formatRelative('2026-05-20T20:30:05.000Z', { now: base })).toBe('5s from now');
  expect(formatRelative('2026-05-20T20:35:00.000Z', { now: base })).toBe('5 min from now');
  expect(formatRelative('2026-05-20T22:30:00.000Z', { now: base })).toBe('2 h from now');
  expect(formatRelative('2026-05-22T20:30:00.000Z', { now: base })).toBe('2 d from now');

  expect(formatRelative('invalid-date')).toBe('');
});

test('formatTimeWithRelative combines timestamp and relative string', () => {
  const base = new Date('2026-05-20T20:30:00.000Z');
  const result = formatTimeWithRelative('2026-05-20T20:29:55.000Z', {
    now: base,
    timeZone: 'UTC',
  });
  expect(result).toBe('20 May 20:29:55 (5s ago)');

  const invalid = formatTimeWithRelative('invalid-date');
  expect(invalid).toBe('invalid-date');
});

test('formatBytes handles sizes correctly', () => {
  expect(formatBytes(-10)).toBe('0 B');
  expect(formatBytes(NaN)).toBe('0 B');
  expect(formatBytes(500)).toBe('500 B');
  expect(formatBytes(1500)).toBe('1.46 KB');
  expect(formatBytes(1024 * 1024 * 5)).toBe('5.00 MB');
  expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.50 GB');
  expect(formatBytes(1024 * 1024 * 1024 * 1024 * 12)).toBe('12.0 TB');
});

test('formatDuration formats ms correctly', () => {
  expect(formatDuration(-5)).toBe('0 ms');
  expect(formatDuration(NaN)).toBe('0 ms');
  expect(formatDuration(500)).toBe('500 ms');
  expect(formatDuration(5500)).toBe('5 s');
  expect(formatDuration(120000)).toBe('2 min');
  expect(formatDuration(3600000 * 3.5)).toBe('3h 30m');
  expect(formatDuration(3600000 * 27)).toBe('1d 3h');
});

test('formatPercent handles edge cases and tiny percents', () => {
  expect(formatPercent(5, 0)).toBe('0%');
  expect(formatPercent(NaN, 10)).toBe('0%');
  expect(formatPercent(5, NaN)).toBe('0%');
  expect(formatPercent(5, 10)).toBe('50%');
  expect(formatPercent(1, 1000)).toBe('<1%');
});
