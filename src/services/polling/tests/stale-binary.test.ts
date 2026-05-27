import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkStaleBinary } from 'services/polling/stale-binary.ts';

let dir: string;

const DAY_MS = 86_400_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-stale-binary-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

function installedAtDaysAgo(days: number, nowMs: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

test('returns fresh when days since install is below warn threshold', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(10, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('fresh');
});

test('returns warning when days since install crosses warn threshold', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(35, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('warning');
});

test('returns warning at exactly warn threshold (boundary inclusive)', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(30, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('warning');
});

test('returns stale when days >= pause threshold', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(75, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('stale');
});

test('returns stale at exactly pause threshold (boundary inclusive)', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(60, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('stale');
});

test('returns fresh when installedAt is unparseable', async () => {
  const result = await checkStaleBinary({
    installedAt: 'not-a-date',
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => Date.parse('2026-05-06T00:00:00.000Z'),
  });
  expect(result.status).toBe('fresh');
});

test('returns fresh when installedAt is in the future', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const future = new Date(nowMs + 5 * DAY_MS).toISOString();
  const result = await checkStaleBinary({
    installedAt: future,
    warnAfterDays: 30,
    pauseAfterDays: 60,
    now: () => nowMs,
  });
  expect(result.status).toBe('fresh');
});

test('zero thresholds disable the check', async () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = await checkStaleBinary({
    installedAt: installedAtDaysAgo(365, nowMs),
    warnAfterDays: 0,
    pauseAfterDays: 0,
    now: () => nowMs,
  });
  expect(result.status).toBe('fresh');
});
