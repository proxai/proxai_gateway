import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-stat-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('statFile returns size, mtime, inode for an existing file', async () => {
  const path = join(dir, 'a.txt');
  await Bun.write(path, 'hello');
  const s = await statFile(path);
  expect(s.exists).toBe(true);
  if (s.exists) {
    expect(s.size).toBe(5);
    expect(typeof s.inode).toBe('bigint');
    expect(s.mtimeMs).toBeGreaterThan(0);
    expect(s.mtimeNs).toBeGreaterThan(0n);
  }
});

test('statFile returns exists:false for a missing path', async () => {
  const s = await statFile(join(dir, 'does-not-exist'));
  expect(s.exists).toBe(false);
});

test('statFile reflects updated size after re-write', async () => {
  const path = join(dir, 'b.txt');
  await Bun.write(path, 'short');
  const a = await statFile(path);
  await Bun.write(path, 'a much longer string');
  const b = await statFile(path);
  expect(a.exists && b.exists).toBe(true);
  if (a.exists && b.exists) {
    expect(b.size).toBeGreaterThan(a.size);
  }
});
