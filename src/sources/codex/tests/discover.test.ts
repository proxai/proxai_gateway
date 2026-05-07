import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCodexRolloutFiles, discoverCodexStateSqlite } from 'sources/codex';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-codex-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

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
  expect(found[0]!.sourcePath).toContain('rollout-deep.jsonl');
});

test('discoverCodexRolloutFiles returns size, inode, mtime, and source_path_hash', async () => {
  await mkdir(join(dir, 'sessions', '2026', '04', '29'), { recursive: true });
  await writeFile(join(dir, 'sessions', '2026', '04', '29', 'rollout-x.jsonl'), '{"a":1}\n');

  const found = await discoverCodexRolloutFiles(dir);
  expect(found[0]!.sizeBytes).toBe(8);
  expect(found[0]!.inode).toBeGreaterThan(0);
  expect(found[0]!.lastModifiedMs).toBeGreaterThan(0);
  expect(found[0]!.sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
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
  expect(found!.sourcePath).toBe(join(dir, 'state_5.sqlite'));
});

test('discoverCodexStateSqlite ignores files that do not match state_<N>.sqlite', async () => {
  await writeFile(join(dir, 'state_5.sqlite-wal'), 'wal');
  await writeFile(join(dir, 'state_5.sqlite-shm'), 'shm');
  await writeFile(join(dir, 'logs_2.sqlite'), 'logs');
  await writeFile(join(dir, 'state_5.sqlite'), 'real');

  const found = await discoverCodexStateSqlite(dir);
  expect(found).not.toBeNull();
  expect(found!.sourcePath).toBe(join(dir, 'state_5.sqlite'));
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
  expect(found[0]!.sourcePath).toBe(newPath);
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
