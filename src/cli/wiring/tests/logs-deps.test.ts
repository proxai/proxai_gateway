import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildLogsDeps } from 'cli/wiring/logs-deps.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-logs-deps-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('buildLogsDeps opens the buffer and returns a working cleanup', async () => {
  const bufferPath = join(dir, 'buffer.db');
  const { deps, cleanup } = await buildLogsDeps({ bufferPath });
  expect(deps.output).toBeDefined();
  expect(deps.buffer).not.toBeNull();
  expect(typeof deps.isDevMode).toBe('boolean');
  expect(() => cleanup()).not.toThrow();
});

test('buildLogsDeps sets buffer to null when the path cannot be opened', async () => {
  const blocker = join(dir, 'not-a-dir');
  await writeFile(blocker, 'x');
  const bufferPath = join(blocker, 'buffer.db');
  const { deps, cleanup } = await buildLogsDeps({ bufferPath });
  expect(deps.buffer).toBeNull();
  expect(typeof deps.isDevMode).toBe('boolean');
  expect(() => cleanup()).not.toThrow();
});

test('buildLogsDeps falls back to the prod buffer path when none is supplied', async () => {
  const { deps, cleanup } = await buildLogsDeps();
  expect(deps.output).toBeDefined();
  expect(typeof deps.isDevMode).toBe('boolean');
  cleanup();
});
