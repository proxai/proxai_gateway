import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor, waitFor } from 'xstate';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import { binaryFreshnessMachine } from 'services/state-machines/binary-freshness/binary-freshness.machine.ts';
import {
  buildStalePauseReason,
  evaluateBinaryFreshness,
} from 'services/state-machines/binary-freshness/binary-freshness.utils.ts';
import { MS_PER_DAY } from 'services/state-machines/binary-freshness/binary-freshness.constants.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-binary-freshness-'));
  sentinelPath = join(dir, 'PAUSED');
});

afterEach(async () => {
  await rmRecursive(dir);
});

function installedAtDaysAgo(days: number, nowMs: number): string {
  return new Date(nowMs - days * MS_PER_DAY).toISOString();
}

async function sendCheckAndSettle(
  actor: ReturnType<typeof createActor<typeof binaryFreshnessMachine>>,
  event: {
    installedAt: string;
    warnAfterDays: number;
    pauseAfterDays: number;
    nowMs: number;
  },
): Promise<string> {
  actor.send({ type: 'CHECK', ...event });
  const snapshot = await waitFor(actor, (s) => s.value !== 'checking');
  return String(snapshot.value);
}

test('evaluateBinaryFreshness returns fresh below warn threshold', () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: installedAtDaysAgo(10, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(result.status).toBe('fresh');
  expect(result.daysSinceInstall).toBe(10);
});

test('evaluateBinaryFreshness returns warning at boundary', () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: installedAtDaysAgo(30, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(result.status).toBe('warning');
});

test('evaluateBinaryFreshness returns stale_paused at pause threshold', () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: installedAtDaysAgo(60, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(result.status).toBe('stale_paused');
  expect(result.daysSinceInstall).toBe(60);
});

test('evaluateBinaryFreshness returns fresh for unparseable installedAt', () => {
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: 'not-a-date',
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
  expect(result.status).toBe('fresh');
  expect(result.daysSinceInstall).toBeNull();
});

test('evaluateBinaryFreshness returns fresh when thresholds are zero', () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: installedAtDaysAgo(365, nowMs),
    warnAfterDays: 0,
    pauseAfterDays: 0,
    nowMs,
  });
  expect(result.status).toBe('fresh');
});

test('evaluateBinaryFreshness clamps future install dates to zero days', () => {
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const result = evaluateBinaryFreshness({
    type: 'CHECK',
    installedAt: new Date(nowMs + 5 * MS_PER_DAY).toISOString(),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(result.status).toBe('fresh');
  expect(result.daysSinceInstall).toBe(0);
});

test('buildStalePauseReason formats the day count and threshold', () => {
  expect(buildStalePauseReason(75, 60)).toBe('stale_binary: 75 days since install (>= 60)');
});

test('machine starts in unchecked state', () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  expect(actor.getSnapshot().value).toBe('unchecked');
  actor.stop();
});

test('machine transitions unchecked -> fresh below warn threshold', async () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const finalState = await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(10, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(finalState).toBe('fresh');
  expect(await isPaused(sentinelPath)).toBe(false);
  actor.stop();
});

test('machine transitions to warning at warn threshold', async () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const finalState = await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(45, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(finalState).toBe('warning');
  expect(await isPaused(sentinelPath)).toBe(false);
  actor.stop();
});

test('machine transitions to stale_paused and writes sentinel', async () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const finalState = await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(75, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(finalState).toBe('stale_paused');
  expect(await isPaused(sentinelPath)).toBe(true);
  const text = await Bun.file(sentinelPath).text();
  expect(text).toContain('stale_binary');
  expect(text).toContain('75');
  actor.stop();
});

test('machine records last evaluation in context', async () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(10, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  const snapshot = actor.getSnapshot();
  expect(snapshot.context.lastEvaluatedAt).toBe(nowMs);
  expect(snapshot.context.lastDaysSinceInstall).toBe(10);
  actor.stop();
});

test('machine re-evaluates on subsequent CHECK events', async () => {
  const actor = createActor(binaryFreshnessMachine, { input: { pauseSentinelPath: sentinelPath } });
  actor.start();
  const nowMs = Date.parse('2026-05-06T00:00:00.000Z');
  const first = await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(10, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(first).toBe('fresh');
  const second = await sendCheckAndSettle(actor, {
    installedAt: installedAtDaysAgo(75, nowMs),
    warnAfterDays: 30,
    pauseAfterDays: 60,
    nowMs,
  });
  expect(second).toBe('stale_paused');
  actor.stop();
});
