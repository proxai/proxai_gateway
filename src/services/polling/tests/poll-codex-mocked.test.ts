import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as codexReal from 'sources/codex';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb } from 'services/buffer';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-codex-mock-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

test('captures errors when state collection throws synchronously', async () => {
  await mock.module('sources/codex', () => ({
    collectCodexRollout: async () => ({
      capturedBatches: 0,
      capturedBytes: 0,
      errors: [],
    }),
    collectCodexState: () => {
      throw new Error('forced state failure');
    },
    defaultCodexHome: () => dir,
    discoverCodexRolloutFiles: async () => [],
    discoverCodexStateSqlite: async () => ({
      sourcePath: join(dir, 'fake-state.sqlite'),
      sourcePathHash: 'a'.repeat(64),
      inode: 1,
      sizeBytes: 100,
      lastModifiedMs: Date.now(),
    }),
  }));
  const mod = await import('services/polling/poll-codex.ts');
  const poller = mod.makeCodexSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors.some((e) => e.reason.includes('forced state failure'))).toBe(true);
});

afterAll(() => {
  mock.module('sources/codex', () => codexReal);
});
