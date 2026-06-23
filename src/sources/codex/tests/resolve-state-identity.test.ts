import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { sha256Hex } from 'core/utils';
import { openInMemoryBufferDb } from 'services/buffer';
import { resolveSourceIdentity } from 'sources/codex/resolve-state-identity.ts';
import type { CodexCollectorContext, DiscoveredCodexStateFile } from 'sources/codex/codex.types.ts';

let buffer: ReturnType<typeof openInMemoryBufferDb>;

beforeEach(() => {
  buffer = openInMemoryBufferDb();
});

afterEach(() => {
  try {
    buffer.close();
  } catch {}
});

function stateFile(sourcePath: string): DiscoveredCodexStateFile {
  return {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: 1,
    sizeBytes: 4096,
    lastModifiedMs: Date.now(),
  };
}

function ctx(b: ReturnType<typeof openInMemoryBufferDb>): CodexCollectorContext {
  return { buffer: b, gatewayVersion: 'gw', maxDecompressedBytes: 9 * 1024 * 1024 };
}

test('falls through (no rotation) when getCursorWithFallback throws per allowed table', () => {
  // A closed buffer makes every per-table getCursorWithFallback throw. Each throw is caught and the
  // loop continues to the next allowed table; with no usable cursor, the function returns the
  // un-rotated default identity instead of propagating the error.
  const stateDb = new Database(':memory:');
  // Both allowed state tables exist, so tableExists passes and we reach getCursorWithFallback.
  stateDb.run('CREATE TABLE threads (id TEXT PRIMARY KEY)');
  stateDb.run(
    'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)',
  );

  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();

  const file = stateFile('/codex/state_1.sqlite');
  const identity = resolveSourceIdentity(stateDb, file, ctx(closedBuffer), 4096, 1);

  expect(identity.rotated).toBe(false);
  expect(identity.sourcePath).toBe('/codex/state_1.sqlite');
  expect(identity.sourcePathHash).toBe(sha256Hex('/codex/state_1.sqlite'));

  stateDb.close();
});

test('returns the default identity when no allowed state table exists', () => {
  // No threads / thread_spawn_edges tables -> tableExists is false for every allowed table, so the
  // loop body never runs; the un-rotated default identity is returned. (Healthy-buffer baseline.)
  const stateDb = new Database(':memory:');
  stateDb.run('CREATE TABLE unrelated (x INTEGER)');

  const file = stateFile('/codex/state_2.sqlite');
  const identity = resolveSourceIdentity(stateDb, file, ctx(buffer), 4096, 1);

  expect(identity.rotated).toBe(false);
  expect(identity.sourcePath).toBe('/codex/state_2.sqlite');

  stateDb.close();
});
