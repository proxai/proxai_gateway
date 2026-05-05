import { test, expect } from 'bun:test';

import { exponentialBackoff, parseRetryAfter } from 'core/utils';

test('exponentialBackoff doubles up to the cap with jitter=0', () => {
  const it = exponentialBackoff({ initialMs: 100, maxMs: 1000, multiplier: 2, jitter: 0 });
  const seq = Array.from({ length: 6 }, () => it.next().value as number);
  expect(seq).toEqual([100, 200, 400, 800, 1000, 1000]);
});

test('exponentialBackoff stays non-negative under jitter', () => {
  const it = exponentialBackoff({ initialMs: 1000, maxMs: 10_000, multiplier: 2, jitter: 0.5 });
  for (let i = 0; i < 50; i++) {
    const v = it.next().value as number;
    expect(v).toBeGreaterThanOrEqual(0);
  }
});

test('parseRetryAfter handles seconds form', () => {
  expect(parseRetryAfter('30')).toBe(30_000);
  expect(parseRetryAfter('0')).toBe(0);
  expect(parseRetryAfter('1.5')).toBe(1500);
});

test('parseRetryAfter handles HTTP-date form', () => {
  const now = Date.now();
  const future = new Date(now + 60_000).toUTCString();
  const ms = parseRetryAfter(future, now);
  expect(ms).toBeGreaterThan(50_000);
  expect(ms).toBeLessThan(70_000);
});

test('parseRetryAfter clamps past dates to 0', () => {
  const now = Date.now();
  const past = new Date(now - 60_000).toUTCString();
  expect(parseRetryAfter(past, now)).toBe(0);
});

test('parseRetryAfter returns null for missing / blank / unparseable', () => {
  expect(parseRetryAfter(null)).toBeNull();
  expect(parseRetryAfter(undefined)).toBeNull();
  expect(parseRetryAfter('')).toBeNull();
  expect(parseRetryAfter('   ')).toBeNull();
  expect(parseRetryAfter('not a date')).toBeNull();
});
