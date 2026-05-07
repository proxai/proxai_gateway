import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearSessionStoppedSentinel,
  isCurrentSessionStopped,
  readSessionStoppedSentinel,
  writeSessionStoppedSentinel,
} from 'services/polling/session-stopped-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-session-stopped-'));
  sentinelPath = join(dir, 'SESSION_STOPPED');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('readSessionStoppedSentinel returns null when missing', async () => {
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('write -> read round-trips bootId and setAt', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-abc',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const payload = await readSessionStoppedSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.bootId).toBe('boot-abc');
  expect(payload?.setAt).toBe('2026-05-06T00:00:00.000Z');
});

test('on-disk payload uses snake_case boot_id and set_at', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-abc',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const text = await Bun.file(sentinelPath).text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(parsed['boot_id']).toBe('boot-abc');
  expect(parsed['set_at']).toBe('2026-05-06T00:00:00.000Z');
});

test('readSessionStoppedSentinel returns null on invalid JSON', async () => {
  await Bun.write(sentinelPath, 'not-json');
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('readSessionStoppedSentinel returns null when boot_id missing', async () => {
  await Bun.write(sentinelPath, JSON.stringify({ set_at: 'x' }));
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('clearSessionStoppedSentinel removes the sentinel', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-abc',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  await clearSessionStoppedSentinel(sentinelPath);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('clearSessionStoppedSentinel is idempotent on missing file', async () => {
  await clearSessionStoppedSentinel(sentinelPath);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('isCurrentSessionStopped returns false when sentinel missing', async () => {
  expect(await isCurrentSessionStopped(sentinelPath, 'any-boot')).toBe(false);
});

test('isCurrentSessionStopped returns true when boot_id matches', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-abc',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  expect(await isCurrentSessionStopped(sentinelPath, 'boot-abc')).toBe(true);

  expect(await readSessionStoppedSentinel(sentinelPath)).not.toBeNull();
});

test('isCurrentSessionStopped returns false on mismatch and deletes the stale sentinel', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-old',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  expect(await isCurrentSessionStopped(sentinelPath, 'boot-new')).toBe(false);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('writing twice overwrites prior content (idempotent set)', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'first',
    setAt: '2026-01-01T00:00:00.000Z',
  });
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'second',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const payload = await readSessionStoppedSentinel(sentinelPath);
  expect(payload?.bootId).toBe('second');
  expect(payload?.setAt).toBe('2026-05-06T00:00:00.000Z');
});
