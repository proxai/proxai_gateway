import { test, expect } from 'bun:test';

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
