import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-dev-mode-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('returns false when sentinel file does not exist', async () => {
  const sentinelPath = join(dir, 'NON_EXISTENT_SENTINEL');
  const result = await readDevModeSentinel(sentinelPath, () => Promise.resolve('boot-123'));
  expect(result).toBe(false);
});

test('returns false and preserves file when JSON is malformed', async () => {
  const sentinelPath = join(dir, 'MALFORMED_SENTINEL');
  writeFileSync(sentinelPath, 'invalid-json');

  const result = await readDevModeSentinel(sentinelPath, () => Promise.resolve('boot-123'));
  expect(result).toBe(false);
  expect(existsSync(sentinelPath)).toBe(true);
});

test('returns false and preserves file when bootId is missing or not a string', async () => {
  const sentinelPath = join(dir, 'MISSING_BOOTID_SENTINEL');
  writeFileSync(sentinelPath, JSON.stringify({ notBootId: 123 }));

  const result = await readDevModeSentinel(sentinelPath, () => Promise.resolve('boot-123'));
  expect(result).toBe(false);
  expect(existsSync(sentinelPath)).toBe(true);
});

test('returns false and preserves file when stored bootId does not match current bootId', async () => {
  const sentinelPath = join(dir, 'MISMATCH_BOOTID_SENTINEL');
  writeFileSync(sentinelPath, JSON.stringify({ bootId: 'boot-abc' }));

  const result = await readDevModeSentinel(sentinelPath, () => Promise.resolve('boot-123'));
  expect(result).toBe(false);
  expect(existsSync(sentinelPath)).toBe(true);
});

test('returns true and preserves file when stored bootId matches current bootId', async () => {
  const sentinelPath = join(dir, 'MATCH_BOOTID_SENTINEL');
  writeFileSync(sentinelPath, JSON.stringify({ bootId: 'boot-123' }));

  const result = await readDevModeSentinel(sentinelPath, () => Promise.resolve('boot-123'));
  expect(result).toBe(true);
  expect(existsSync(sentinelPath)).toBe(true);
});
