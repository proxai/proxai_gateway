import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, sentinelHandle } from 'core/io/fs';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sentinel-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('write / read / exists / remove cycle', async () => {
  const h = sentinelHandle(join(dir, 'PAUSED'));
  expect(await h.exists()).toBe(false);
  expect(await h.read()).toBe('');
  await h.write('reason: test');
  expect(await h.exists()).toBe(true);
  expect(await h.read()).toBe('reason: test');
  await h.remove();
  expect(await h.exists()).toBe(false);
});

test('remove on a missing file is a no-op', async () => {
  const h = sentinelHandle(join(dir, 'nope'));
  await h.remove();
  expect(await h.exists()).toBe(false);
});

test('write overwrites previous body', async () => {
  const h = sentinelHandle(join(dir, 'CONSENT_ACCEPTED'));
  await h.write('v1');
  await h.write('v2');
  expect(await h.read()).toBe('v2');
});
