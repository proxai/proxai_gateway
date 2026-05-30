import { test, expect } from 'bun:test';

import { daysSince } from 'core/utils';

import { monotonicMs, nowIsoUtc } from 'core/utils';

test('nowIsoUtc returns RFC 3339 UTC with Z suffix and ms precision', () => {
  expect(nowIsoUtc()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('monotonicMs is non-decreasing across two reads', () => {
  const a = monotonicMs();
  const b = monotonicMs();
  expect(b).toBeGreaterThanOrEqual(a);
});

test('monotonicMs advances over a sleep', async () => {
  const a = monotonicMs();
  await Bun.sleep(10);
  const b = monotonicMs();
  expect(b - a).toBeGreaterThanOrEqual(8);
});

test('daysSince returns null for an unparseable date string', () => {
  expect(daysSince('not-a-date', new Date())).toBeNull();
});

test('daysSince returns whole days elapsed for a past ISO date', () => {
  const now = new Date('2025-06-10T12:00:00.000Z');
  const iso = '2025-06-07T12:00:00.000Z';
  expect(daysSince(iso, now)).toBe(3);
});

test('daysSince returns 0 when now is before the given ISO date', () => {
  const now = new Date('2025-06-01T00:00:00.000Z');
  const iso = '2025-06-10T00:00:00.000Z';
  expect(daysSince(iso, now)).toBe(0);
});

import { abortableSleep } from 'core/utils';

test('abortableSleep resolves after the given delay when not aborted', async () => {
  const start = Date.now();
  await abortableSleep(20);
  expect(Date.now() - start).toBeGreaterThanOrEqual(15);
});

test('abortableSleep resolves immediately when signal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const start = Date.now();
  await abortableSleep(10_000, ctrl.signal);
  expect(Date.now() - start).toBeLessThan(50);
});

test('abortableSleep resolves when signal aborts mid-sleep', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5);
  const start = Date.now();
  await abortableSleep(10_000, ctrl.signal);
  expect(Date.now() - start).toBeLessThan(500);
});
