import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearBufferFullSentinel,
  isBufferFull,
  readBufferFullSentinel,
  writeBufferFullSentinel,
} from 'services/polling/buffer-full-sentinel.ts';

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-buffer-full-test-'));
  sentinelPath = join(dir, 'BUFFER_FULL');
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('isBufferFull returns false when sentinel does not exist', async () => {
  expect(await isBufferFull(sentinelPath)).toBe(false);
});

test('writeBufferFullSentinel + isBufferFull reports true', async () => {
  await writeBufferFullSentinel(sentinelPath, { pendingBytes: 1024, threshold: 800 });
  expect(await isBufferFull(sentinelPath)).toBe(true);
});

test('readBufferFullSentinel returns parsed payload', async () => {
  await writeBufferFullSentinel(
    sentinelPath,
    { pendingBytes: 1024, threshold: 800 },
    () => '2026-05-06T12:00:00.000Z',
  );
  const payload = await readBufferFullSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.pendingBytes).toBe(1024);
  expect(payload?.threshold).toBe(800);
  expect(payload?.setAt).toBe('2026-05-06T12:00:00.000Z');
});

test('readBufferFullSentinel returns null on missing file', async () => {
  expect(await readBufferFullSentinel(sentinelPath)).toBeNull();
});

test('readBufferFullSentinel returns null on malformed JSON', async () => {
  await Bun.write(sentinelPath, 'not json');
  expect(await readBufferFullSentinel(sentinelPath)).toBeNull();
});

test('clearBufferFullSentinel removes the file', async () => {
  await writeBufferFullSentinel(sentinelPath, { pendingBytes: 1, threshold: 1 });
  await clearBufferFullSentinel(sentinelPath);
  expect(await isBufferFull(sentinelPath)).toBe(false);
});

test('clearBufferFullSentinel is idempotent on missing file', async () => {
  await clearBufferFullSentinel(sentinelPath);
  expect(await isBufferFull(sentinelPath)).toBe(false);
});

test('writeBufferFullSentinel sets mode 0600 on Unix', async () => {
  if (process.platform === 'win32') return;
  await writeBufferFullSentinel(sentinelPath, { pendingBytes: 1, threshold: 1 });
  const s = await stat(sentinelPath);
  expect(s.mode & 0o777).toBe(0o600);
});
