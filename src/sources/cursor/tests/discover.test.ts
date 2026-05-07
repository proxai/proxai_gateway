import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCursorFiles } from 'sources/cursor';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-cursor-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('returns empty list when the user directory does not exist', async () => {
  const found = await discoverCursorFiles(join(dir, 'no-such-dir'));
  expect(found).toEqual([]);
});

test('returns empty list when nothing is on disk', async () => {
  const found = await discoverCursorFiles(dir);
  expect(found).toEqual([]);
});

test('discovers the global state.vscdb file', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  await writeFile(join(dir, 'globalStorage', 'state.vscdb'), 'placeholder');

  const found = await discoverCursorFiles(dir);
  expect(found).toHaveLength(1);
  expect(found[0]!.sourcePath).toBe(join(dir, 'globalStorage', 'state.vscdb'));
});

test('discovers workspace state.vscdb files alongside the global one', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  await writeFile(join(dir, 'globalStorage', 'state.vscdb'), 'global');
  await mkdir(join(dir, 'workspaceStorage', 'ws-1'), { recursive: true });
  await writeFile(join(dir, 'workspaceStorage', 'ws-1', 'state.vscdb'), 'ws1');
  await mkdir(join(dir, 'workspaceStorage', 'ws-2'), { recursive: true });
  await writeFile(join(dir, 'workspaceStorage', 'ws-2', 'state.vscdb'), 'ws2');

  const found = await discoverCursorFiles(dir);
  expect(found).toHaveLength(3);
  const paths = found.map((f) => f.sourcePath).toSorted();
  expect(paths).toEqual(
    [
      join(dir, 'globalStorage', 'state.vscdb'),
      join(dir, 'workspaceStorage', 'ws-1', 'state.vscdb'),
      join(dir, 'workspaceStorage', 'ws-2', 'state.vscdb'),
    ].toSorted(),
  );
});

test('skips workspace folders that have no state.vscdb', async () => {
  await mkdir(join(dir, 'workspaceStorage', 'ws-empty'), { recursive: true });
  const found = await discoverCursorFiles(dir);
  expect(found).toEqual([]);
});

test('returns size, inode, and mtime for each file', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  await writeFile(join(dir, 'globalStorage', 'state.vscdb'), 'placeholder');

  const found = await discoverCursorFiles(dir);
  expect(found).toHaveLength(1);
  expect(found[0]!.sizeBytes).toBe('placeholder'.length);
  expect(found[0]!.inode).toBeGreaterThan(0);
  expect(found[0]!.lastModifiedMs).toBeGreaterThan(0);
});

test('returns sha256 source_path_hash matching the absolute path', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  await writeFile(join(dir, 'globalStorage', 'state.vscdb'), 'placeholder');

  const found = await discoverCursorFiles(dir);
  expect(found[0]!.sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
});

test('skips files older than minimumMtime, keeps newer ones', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  const oldPath = join(dir, 'globalStorage', 'state.vscdb');
  await writeFile(oldPath, 'old');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  await mkdir(join(dir, 'workspaceStorage', 'ws-fresh'), { recursive: true });
  const newPath = join(dir, 'workspaceStorage', 'ws-fresh', 'state.vscdb');
  await writeFile(newPath, 'new');

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverCursorFiles(dir, { minimumMtime: cutoff });
  expect(found).toHaveLength(1);
  expect(found[0]!.sourcePath).toBe(newPath);
});

test('null minimumMtime means no cap (all files included)', async () => {
  await mkdir(join(dir, 'globalStorage'), { recursive: true });
  const oldPath = join(dir, 'globalStorage', 'state.vscdb');
  await writeFile(oldPath, 'old');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverCursorFiles(dir, { minimumMtime: null });
  expect(found).toHaveLength(1);
});
