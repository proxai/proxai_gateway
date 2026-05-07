import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isPaused,
  pausePolling,
  readPauseReason,
  resumePolling,
} from 'services/polling/pause-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-polling-test-'));
  sentinelPath = join(dir, 'PAUSED');
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('isPaused returns false when sentinel does not exist', async () => {
  expect(await isPaused(sentinelPath)).toBe(false);
});

test('pausePolling creates the sentinel and isPaused returns true', async () => {
  await pausePolling(sentinelPath);
  expect(await isPaused(sentinelPath)).toBe(true);
});

test('pausePolling stores the reason and readPauseReason returns it', async () => {
  await pausePolling(sentinelPath, 'manual override');
  expect(await readPauseReason(sentinelPath)).toBe('manual override');
});

test('pausePolling without reason writes empty string', async () => {
  await pausePolling(sentinelPath);
  expect(await readPauseReason(sentinelPath)).toBe('');
});

test('readPauseReason returns empty string when file missing', async () => {
  expect(await readPauseReason(sentinelPath)).toBe('');
});

test('resumePolling removes the sentinel', async () => {
  await pausePolling(sentinelPath, 'reason');
  await resumePolling(sentinelPath);
  expect(await isPaused(sentinelPath)).toBe(false);
});

test('resumePolling is idempotent on missing file', async () => {
  await resumePolling(sentinelPath);
  expect(await isPaused(sentinelPath)).toBe(false);
});
