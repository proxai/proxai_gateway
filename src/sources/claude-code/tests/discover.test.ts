import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverClaudeCodeFiles } from 'sources/claude-code';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-discover-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
