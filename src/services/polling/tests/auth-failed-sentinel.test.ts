import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearAuthFailedSentinel,
  isAuthFailed,
  readAuthFailedSentinel,
  writeAuthFailedSentinel,
} from 'services/polling/auth-failed-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-auth-sentinel-'));
  sentinelPath = join(dir, 'AUTH_FAILED');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('isAuthFailed returns false when sentinel does not exist', async () => {
  expect(await isAuthFailed(sentinelPath)).toBe(false);
});

test('writeAuthFailedSentinel creates the sentinel and isAuthFailed returns true', async () => {
  await writeAuthFailedSentinel(sentinelPath, 'key revoked');
  expect(await isAuthFailed(sentinelPath)).toBe(true);
});

test('readAuthFailedSentinel returns reason and detected_at', async () => {
  await writeAuthFailedSentinel(sentinelPath, 'key revoked', () => '2026-05-06T00:00:00.000Z');
  const payload = await readAuthFailedSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.reason).toBe('key revoked');
  expect(payload?.detectedAt).toBe('2026-05-06T00:00:00.000Z');
});

test('readAuthFailedSentinel returns null when missing', async () => {
  expect(await readAuthFailedSentinel(sentinelPath)).toBeNull();
});

test('readAuthFailedSentinel falls back to plain text on invalid JSON', async () => {
  await Bun.write(sentinelPath, 'not-json');
  const payload = await readAuthFailedSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.reason).toBe('not-json');
  expect(payload?.detectedAt).toBe('');
});

test('clearAuthFailedSentinel removes the sentinel', async () => {
  await writeAuthFailedSentinel(sentinelPath, 'reason');
  await clearAuthFailedSentinel(sentinelPath);
  expect(await isAuthFailed(sentinelPath)).toBe(false);
});

test('clearAuthFailedSentinel is idempotent on missing file', async () => {
  await clearAuthFailedSentinel(sentinelPath);
  expect(await isAuthFailed(sentinelPath)).toBe(false);
});

test('payload uses snake_case detected_at on disk', async () => {
  await writeAuthFailedSentinel(sentinelPath, 'reason', () => '2026-05-06T00:00:00.000Z');
  const text = await Bun.file(sentinelPath).text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(parsed['reason']).toBe('reason');
  expect(parsed['detected_at']).toBe('2026-05-06T00:00:00.000Z');
});
