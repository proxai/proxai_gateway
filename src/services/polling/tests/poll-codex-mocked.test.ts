import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as codexReal from 'sources/codex';
import { openInMemoryBufferDb } from 'services/buffer';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-codex-mock-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
  // Restore the real `sources/codex` module. `mock.module` in Bun mutates the
  // module registry process-wide and `mock.restore()` does not unwind module
  // mocks — the only reliable cleanup is to re-mock the path back to the real
  // exports. Without this, tests that load AFTER this file see the stub
  // exports and fail across platforms whose test ordering happens to load
  // this file before `src/sources/codex/tests/*` or `src/services/polling/tests/poll-codex.test.ts`.
  await mock.module('sources/codex', () => codexReal);
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
  const result = await poller({ buffer, gatewayVersion: 'gw-0.1' });
  expect(result.errors.some((e) => e.reason.includes('forced state failure'))).toBe(true);
});
