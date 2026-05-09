import { expect, test } from 'bun:test';

import { daysSince } from 'core/utils/time.ts';

test('daysSince: returns null for unparseable input', () => {
  expect(daysSince('garbage', new Date())).toBe(null);
});

test('daysSince: zero on same day (within 24h)', () => {
  const now = new Date('2026-05-08T12:00:00Z');
  expect(daysSince('2026-05-08T11:00:00Z', now)).toBe(0);
});

test('daysSince: positive integer days', () => {
  const now = new Date('2026-05-10T00:00:00Z');
  expect(daysSince('2026-05-08T00:00:00Z', now)).toBe(2);
});

test('daysSince: negative diff clamped to 0', () => {
  const now = new Date('2026-05-08T00:00:00Z');
  expect(daysSince('2026-06-01T00:00:00Z', now)).toBe(0);
});
