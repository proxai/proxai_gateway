import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearUpdateAvailableSentinel,
  isUpdateAvailable,
  readUpdateAvailableSentinel,
  writeUpdateAvailableSentinel,
} from 'services/polling/update-available-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-update-sentinel-'));
  sentinelPath = join(dir, 'UPDATE_AVAILABLE');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('isUpdateAvailable returns false when sentinel does not exist', async () => {
  expect(await isUpdateAvailable(sentinelPath)).toBe(false);
});

test('writeUpdateAvailableSentinel creates the sentinel and isUpdateAvailable returns true', async () => {
  await writeUpdateAvailableSentinel(sentinelPath, {
    latest_version: '2026.5.10',
    current_version: '2026.5.7',
  });
  expect(await isUpdateAvailable(sentinelPath)).toBe(true);
});

test('readUpdateAvailableSentinel returns the parsed payload', async () => {
  await writeUpdateAvailableSentinel(sentinelPath, {
    latest_version: '2026.5.10',
    current_version: '2026.5.7',
    detected_at: '2026-05-06T00:00:00.000Z',
    asset_url: 'https://example.com/asset',
  });
  const payload = await readUpdateAvailableSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.latestVersion).toBe('2026.5.10');
  expect(payload?.currentVersion).toBe('2026.5.7');
  expect(payload?.detectedAt).toBe('2026-05-06T00:00:00.000Z');
  expect(payload?.assetUrl).toBe('https://example.com/asset');
});

test('readUpdateAvailableSentinel returns null when missing', async () => {
  expect(await readUpdateAvailableSentinel(sentinelPath)).toBeNull();
});

test('readUpdateAvailableSentinel returns null on invalid JSON', async () => {
  await Bun.write(sentinelPath, 'not-json');
  expect(await readUpdateAvailableSentinel(sentinelPath)).toBeNull();
});

test('clearUpdateAvailableSentinel removes the sentinel', async () => {
  await writeUpdateAvailableSentinel(sentinelPath, {
    latest_version: '2026.5.10',
    current_version: '2026.5.7',
  });
  await clearUpdateAvailableSentinel(sentinelPath);
  expect(await isUpdateAvailable(sentinelPath)).toBe(false);
});

test('clearUpdateAvailableSentinel is idempotent on missing file', async () => {
  await clearUpdateAvailableSentinel(sentinelPath);
  expect(await isUpdateAvailable(sentinelPath)).toBe(false);
});

test('payload uses snake_case keys on disk', async () => {
  await writeUpdateAvailableSentinel(sentinelPath, {
    latest_version: '2026.5.10',
    current_version: '2026.5.7',
    detected_at: '2026-05-06T00:00:00.000Z',
    asset_url: 'https://example.com/asset',
  });
  const text = await Bun.file(sentinelPath).text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(parsed['latest_version']).toBe('2026.5.10');
  expect(parsed['current_version']).toBe('2026.5.7');
  expect(parsed['detected_at']).toBe('2026-05-06T00:00:00.000Z');
  expect(parsed['asset_url']).toBe('https://example.com/asset');
});
