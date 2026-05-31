import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb } from 'services/buffer';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';

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
  // Inject a throwing state collector instead of mock.module('sources/codex'):
  // a global module mock leaks the fake into other files' real codex tests
  // under CI's load order.
  const poller = makeCodexSourcePoller({
    baseDir: dir,
    deps: {
      collectCodexState: () => {
        throw new Error('forced state failure');
      },
      collectCodexRollout: async () => ({ capturedBatches: 0, capturedBytes: 0, errors: [] }),
      discoverCodexRolloutFiles: async () => [],
      discoverCodexStateSqlite: async () => ({
        sourcePath: join(dir, 'fake-state.sqlite'),
        sourcePathHash: 'a'.repeat(64),
        inode: 1,
        sizeBytes: 100,
        lastModifiedMs: Date.now(),
      }),
    },
  });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.errors.some((e) => e.reason.includes('forced state failure'))).toBe(true);
});
