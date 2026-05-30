import { requireDefined } from 'core/utils';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildChildRolloutSet,
  defaultCodexHome,
  discoverCodexRolloutFiles,
  discoverCodexStateSqlite,
  readChildRolloutPaths,
  readChildRolloutPathsFromDb,
  resolveExcludeRolloutPaths,
} from 'sources/codex';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-codex-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

interface FakeStatement<T> {
  all: () => T[];
}

function fakeDb<T>(rows: T[]): Database {
  const db: unknown = {
    query<R>(_sql: string): FakeStatement<R> {
      const widenedRows: unknown = rows;
      return { all: () => widenedRows as R[] };
    },
    close(): void {},
  };
  return db as Database;
}

test('discoverCodexRolloutFiles returns empty list when the codex home does not exist', async () => {
  const found = await discoverCodexRolloutFiles(join(dir, 'no-such-dir'));
  expect(found).toEqual([]);
});

test('discoverCodexRolloutFiles finds rollout files at year/month/day depth', async () => {
  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  await writeFile(
    join(dir, 'sessions', '2026', '04', '29', 'rollout-2026-04-29T10-00-00-uuid.jsonl'),
    '{"a":1}\n',
  );
  await mkdir(join(dir, 'sessions', '2026', '05', '01'), { recursive: true });
  await writeFile(
    join(dir, 'sessions', '2026', '05', '01', 'rollout-2026-05-01T11-00-00-uuid.jsonl'),
    '{"b":2}\n',
  );

  const found = await discoverCodexRolloutFiles(dir);
  expect(found).toHaveLength(2);
});

test('discoverCodexRolloutFiles ignores non-rollout files in the date partitions', async () => {
  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '04', '29', 'rollout-x.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'sessions', '2026', '04', '29', 'README.md'), '# notes');

  const found = await discoverCodexRolloutFiles(dir);
  expect(found).toHaveLength(1);
});

test('discoverCodexRolloutFiles ignores files at the wrong depth', async () => {
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(dir, 'sessions', 'rollout-top.jsonl'), '{"a":1}\n');
  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '04', '29', 'rollout-deep.jsonl'), '{"a":1}\n');

  const found = await discoverCodexRolloutFiles(dir);
  expect(found).toHaveLength(1);
  expect(requireDefined(found[0]).sourcePath).toContain('rollout-deep.jsonl');
});

test('discoverCodexRolloutFiles returns size, inode, mtime, and source_path_hash', async () => {
  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '04', '29', 'rollout-x.jsonl'), '{"a":1}\n');

  const found = await discoverCodexRolloutFiles(dir);
  expect(requireDefined(found[0]).sizeBytes).toBe(8);
  expect(requireDefined(found[0]).inode).toBeGreaterThan(0);
  expect(requireDefined(found[0]).lastModifiedMs).toBeGreaterThan(0);
  expect(requireDefined(found[0]).sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
});

test('discoverCodexStateSqlite returns null when the codex home does not exist', async () => {
  const found = await discoverCodexStateSqlite(join(dir, 'no-such-dir'));
  expect(found).toBeNull();
});

test('discoverCodexStateSqlite returns null when no state files are present', async () => {
  const found = await discoverCodexStateSqlite(dir);
  expect(found).toBeNull();
});

test('discoverCodexStateSqlite picks the highest-numbered state file', async () => {
  await writeFile(join(dir, 'state_3.sqlite'), 'placeholder');
  await writeFile(join(dir, 'state_5.sqlite'), 'placeholder');
  await writeFile(join(dir, 'state_4.sqlite'), 'placeholder');

  const found = await discoverCodexStateSqlite(dir);
  expect(found).not.toBeNull();
  expect(requireDefined(found).sourcePath).toBe(join(dir, 'state_5.sqlite'));
});

test('discoverCodexStateSqlite ignores files that do not match state_<N>.sqlite', async () => {
  await writeFile(join(dir, 'state_5.sqlite-wal'), 'wal');
  await writeFile(join(dir, 'state_5.sqlite-shm'), 'shm');
  await writeFile(join(dir, 'logs_2.sqlite'), 'logs');
  await writeFile(join(dir, 'state_5.sqlite'), 'real');

  const found = await discoverCodexStateSqlite(dir);
  expect(found).not.toBeNull();
  expect(requireDefined(found).sourcePath).toBe(join(dir, 'state_5.sqlite'));
});

test('discoverCodexRolloutFiles skips rollouts older than minimumMtime', async () => {
  await mkdir(join(dir, 'sessions', '2024', '01', '01'), { recursive: true });
  const oldPath = join(dir, 'sessions', '2024', '01', '01', 'rollout-old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  const newPath = join(dir, 'sessions', '2026', '04', '29', 'rollout-fresh.jsonl');
  await writeFile(newPath, '{"b":2}\n');

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverCodexRolloutFiles(dir, { minimumMtime: cutoff });
  expect(found).toHaveLength(1);
  expect(requireDefined(found[0]).sourcePath).toBe(newPath);
});

test('discoverCodexRolloutFiles with null minimumMtime returns all files', async () => {
  await mkdir(join(dir, 'sessions', '2024', '01', '01'), { recursive: true });
  const oldPath = join(dir, 'sessions', '2024', '01', '01', 'rollout-old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverCodexRolloutFiles(dir, { minimumMtime: null });
  expect(found).toHaveLength(1);
});

test('discoverCodexStateSqlite returns null when state file mtime is below cap', async () => {
  const statePath = join(dir, 'state_5.sqlite');
  await writeFile(statePath, 'placeholder');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(statePath, oldEpoch, oldEpoch);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverCodexStateSqlite(dir, { minimumMtime: cutoff });
  expect(found).toBeNull();
});

test('buildChildRolloutSet returns absolute paths from rows with non-empty string rollout_path', () => {
  const set = buildChildRolloutSet([
    { rollout_path: '/abs/a.jsonl' },
    { rollout_path: '/abs/b.jsonl' },
  ]);
  expect(set.size).toBe(2);
  expect(set.has('/abs/a.jsonl')).toBe(true);
  expect(set.has('/abs/b.jsonl')).toBe(true);
});

test('buildChildRolloutSet skips rows whose rollout_path is empty / null / non-string', () => {
  const set = buildChildRolloutSet([
    { rollout_path: '' },
    { rollout_path: null },
    { rollout_path: undefined },
    { rollout_path: 42 },
    { rollout_path: '/abs/real.jsonl' },
  ]);
  expect(set.size).toBe(1);
  expect(set.has('/abs/real.jsonl')).toBe(true);
});

test('buildChildRolloutSet on empty input returns empty set', () => {
  const set = buildChildRolloutSet([]);
  expect(set.size).toBe(0);
});

test('readChildRolloutPathsFromDb with both tables present returns the joined rollout paths', () => {
  const db = fakeDb([{ rollout_path: '/abs/c1.jsonl' }, { rollout_path: '/abs/c2.jsonl' }]);
  const set = readChildRolloutPathsFromDb(db, () => true);
  expect(set.size).toBe(2);
  expect(set.has('/abs/c1.jsonl')).toBe(true);
});

test('readChildRolloutPathsFromDb returns empty when thread_spawn_edges is missing', () => {
  const db = fakeDb([{ rollout_path: '/should-not-appear' }]);
  const set = readChildRolloutPathsFromDb(db, (_d, name) => name !== 'thread_spawn_edges');
  expect(set.size).toBe(0);
});

test('readChildRolloutPathsFromDb returns empty when threads is missing', () => {
  const db = fakeDb([{ rollout_path: '/should-not-appear' }]);
  const set = readChildRolloutPathsFromDb(db, (_d, name) => name !== 'threads');
  expect(set.size).toBe(0);
});

test('readChildRolloutPaths success path through DI: open returns fake, hasTable true, set returned', () => {
  const db = fakeDb([{ rollout_path: '/abs/p.jsonl' }]);
  let closed = false;
  const fakeOpen = (_path: string): Database => {
    const wrapped: unknown = {
      ...db,
      close: () => {
        closed = true;
      },
    };
    return wrapped as Database;
  };
  const set = readChildRolloutPaths('/any/path.sqlite', {
    openDb: fakeOpen,
    hasTable: () => true,
  });
  expect(set.size).toBe(1);
  expect(set.has('/abs/p.jsonl')).toBe(true);
  expect(closed).toBe(true);
});

test('readChildRolloutPaths catches openDb errors and returns empty set (fail-open)', () => {
  const set = readChildRolloutPaths('/any/path.sqlite', {
    openDb: () => {
      throw new Error('boom');
    },
    hasTable: () => true,
  });
  expect(set.size).toBe(0);
});

test('readChildRolloutPaths real-default-opener on a non-existent path returns empty set', () => {
  const set = readChildRolloutPaths(join(dir, 'never-existed.sqlite'));
  expect(set.size).toBe(0);
});

test('resolveExcludeRolloutPaths: captureSubAgents=true short-circuits to empty set', async () => {
  const set = await resolveExcludeRolloutPaths(dir, true, () => {
    throw new Error('should not be called');
  });
  expect(set.size).toBe(0);
});

test('resolveExcludeRolloutPaths: captureSubAgents=false + no state.sqlite returns empty set', async () => {
  const set = await resolveExcludeRolloutPaths(dir, false, () => {
    throw new Error('should not be called when state file is missing');
  });
  expect(set.size).toBe(0);
});

test('resolveExcludeRolloutPaths: captureSubAgents=false + state.sqlite present passes through to readChildren', async () => {
  await writeFile(join(dir, 'state_1.sqlite'), 'placeholder');
  const set = await resolveExcludeRolloutPaths(dir, false, (path) => {
    expect(path).toBe(join(dir, 'state_1.sqlite'));
    return new Set(['/abs/child-1.jsonl', '/abs/child-2.jsonl']);
  });
  expect(set.size).toBe(2);
  expect(set.has('/abs/child-1.jsonl')).toBe(true);
});

test('discoverCodexRolloutFiles with default (flag off) + injected readChildRolloutPaths filters matching rollouts', async () => {
  const parentRollout = join(dir, 'sessions', '2026', '05', '08', 'rollout-parent.jsonl');
  const childRollout = join(dir, 'sessions', '2026', '05', '08', 'rollout-child.jsonl');
  await mkdir(join(dir, 'sessions', '2026', '05', '08'), { recursive: true });
  await writeFile(parentRollout, '{"a":1}\n');
  await writeFile(childRollout, '{"b":2}\n');
  await writeFile(join(dir, 'state_1.sqlite'), 'placeholder');

  const found = await discoverCodexRolloutFiles(dir, {
    readChildRolloutPaths: () => new Set([childRollout]),
  });
  const paths = found.map((f) => f.sourcePath);
  expect(paths).toEqual([parentRollout]);
});

test('discoverCodexRolloutFiles with captureSubAgents: true does NOT call readChildRolloutPaths', async () => {
  const parentRollout = join(dir, 'sessions', '2026', '05', '08', 'rollout-parent.jsonl');
  const childRollout = join(dir, 'sessions', '2026', '05', '08', 'rollout-child.jsonl');
  await mkdir(join(dir, 'sessions', '2026', '05', '08'), { recursive: true });
  await writeFile(parentRollout, '{"a":1}\n');
  await writeFile(childRollout, '{"b":2}\n');
  await writeFile(join(dir, 'state_1.sqlite'), 'placeholder');

  let called = false;
  const found = await discoverCodexRolloutFiles(dir, {
    captureSubAgents: true,
    readChildRolloutPaths: () => {
      called = true;
      return new Set([childRollout]);
    },
  });
  expect(called).toBe(false);
  expect(found).toHaveLength(2);
});

test('discoverCodexRolloutFiles with flag off + no state.sqlite + child-looking rollouts: all pass through', async () => {
  await mkdir(join(dir, 'sessions', '2026', '05', '08'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '05', '08', 'rollout-x.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'sessions', '2026', '05', '08', 'rollout-y.jsonl'), '{"b":2}\n');

  const found = await discoverCodexRolloutFiles(dir, {
    readChildRolloutPaths: () => {
      throw new Error('should not be called without state.sqlite');
    },
  });
  expect(found).toHaveLength(2);
});

test('defaultCodexHome returns a path ending with the .codex subpath under homedir', () => {
  const result = defaultCodexHome();
  expect(result).toContain(join('.codex'));
  expect(result.length).toBeGreaterThan(join('.codex').length);
});
