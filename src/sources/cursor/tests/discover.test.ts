import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCursorFiles } from 'sources/cursor';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-cursor-discover-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
