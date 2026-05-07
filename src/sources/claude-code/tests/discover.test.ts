import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverClaudeCodeFiles } from 'sources/claude-code';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('returns empty list when the projects directory does not exist', async () => {
  const found = await discoverClaudeCodeFiles(join(dir, 'no-such-dir'));
  expect(found).toEqual([]);
});

test('returns empty list when the projects directory exists but has no files', async () => {
  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toEqual([]);
});

test('discovers session files in project subdirectories', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await mkdir(join(dir, 'project-b'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session-1.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'project-a', 'session-2.jsonl'), '{"b":2}\n');
  await writeFile(join(dir, 'project-b', 'session-3.jsonl'), '{"c":3}\n');

  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toHaveLength(3);
});

test('skips files at the projects-root level (only one-level-nested)', async () => {
  await writeFile(join(dir, 'top-level.jsonl'), '{"a":1}\n');
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session-1.jsonl'), '{"a":1}\n');

  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toHaveLength(1);
  expect(found[0]!.sourcePath).toContain('project-a');
});

test('skips non-jsonl files', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session-1.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'project-a', 'README.md'), '# project');

  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toHaveLength(1);
});

test('returns size, inode, and mtime for each file', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session.jsonl'), '{"a":1}\n');

  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toHaveLength(1);
  expect(found[0]!.sizeBytes).toBe(8);
  expect(found[0]!.inode).toBeGreaterThan(0);
  expect(found[0]!.lastModifiedMs).toBeGreaterThan(0);
});

test('returns sha256 source_path_hash matching the absolute path', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session.jsonl'), '{"a":1}\n');

  const found = await discoverClaudeCodeFiles(dir);
  expect(found[0]!.sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
});

test('skips files older than minimumMtime, keeps newer ones', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'old.jsonl');
  const newPath = join(dir, 'project-a', 'new.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  await writeFile(newPath, '{"b":2}\n');

  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  const newEpoch = new Date();
  await utimes(oldPath, oldEpoch, oldEpoch);
  await utimes(newPath, newEpoch, newEpoch);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverClaudeCodeFiles(dir, { minimumMtime: cutoff });
  expect(found).toHaveLength(1);
  expect(found[0]!.sourcePath).toBe(newPath);
});

test('null minimumMtime means no cap (all files included)', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverClaudeCodeFiles(dir, { minimumMtime: null });
  expect(found).toHaveLength(1);
});

test('omitting options means no cap (defaults preserved)', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverClaudeCodeFiles(dir);
  expect(found).toHaveLength(1);
});
