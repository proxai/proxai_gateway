import { requireDefined } from 'core/utils';
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
  expect(requireDefined(found[0]).sourcePath).toContain('project-a');
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
  expect(requireDefined(found[0]).sizeBytes).toBe(8);
  expect(requireDefined(found[0]).inode).toBeGreaterThan(0);
  expect(requireDefined(found[0]).lastModifiedMs).toBeGreaterThan(0);
});

test('returns sha256 source_path_hash matching the absolute path', async () => {
  await mkdir(join(dir, 'project-a'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session.jsonl'), '{"a":1}\n');

  const found = await discoverClaudeCodeFiles(dir);
  expect(requireDefined(found[0]).sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
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
  expect(requireDefined(found[0]).sourcePath).toBe(newPath);
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

test('default (captureSubAgents undefined) does NOT discover sub-agent files', async () => {
  const projectDir = join(dir, 'project-a');
  const subagentsDir = join(projectDir, 'abc-session', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  const parentPath = join(projectDir, 'abc-session.jsonl');
  const subagentPath = join(subagentsDir, 'agent-ab1234.jsonl');
  await writeFile(parentPath, '{"a":1}\n');
  await writeFile(subagentPath, '{"agentId":"ab1234"}\n');

  const found = await discoverClaudeCodeFiles(dir);
  const paths = found.map((f) => f.sourcePath);
  expect(paths).toEqual([parentPath]);
});

test('captureSubAgents: false (explicit) does NOT discover sub-agent files', async () => {
  const projectDir = join(dir, 'project-a');
  const subagentsDir = join(projectDir, 'abc-session', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  const parentPath = join(projectDir, 'abc-session.jsonl');
  const subagentPath = join(subagentsDir, 'agent-ab1234.jsonl');
  await writeFile(parentPath, '{"a":1}\n');
  await writeFile(subagentPath, '{"agentId":"ab1234"}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: false });
  const paths = found.map((f) => f.sourcePath);
  expect(paths).toEqual([parentPath]);
});

test('captureSubAgents: true discovers sub-agent jsonl at <project>/<session>/subagents/agent-<hex>.jsonl', async () => {
  const projectDir = join(dir, 'project-a');
  const subagentsDir = join(projectDir, 'abc-session', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  const parentPath = join(projectDir, 'abc-session.jsonl');
  const subagentPath = join(subagentsDir, 'agent-ab1234.jsonl');
  await writeFile(parentPath, '{"a":1}\n');
  await writeFile(subagentPath, '{"agentId":"ab1234"}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  const paths = found.map((f) => f.sourcePath).toSorted();
  expect(paths).toEqual([parentPath, subagentPath].toSorted());
});

test('captureSubAgents: true discovers multiple sub-agents under a single session directory', async () => {
  const subagentsDir = join(dir, 'project-a', 'abc-session', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(join(subagentsDir, 'agent-aaaaaaaa.jsonl'), '{"agentId":"aaaaaaaa"}\n');
  await writeFile(join(subagentsDir, 'agent-bbbbbbbb.jsonl'), '{"agentId":"bbbbbbbb"}\n');
  await writeFile(join(subagentsDir, 'agent-cccccccc.jsonl'), '{"agentId":"cccccccc"}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  expect(found).toHaveLength(3);
});

test('captureSubAgents: true rejects deeper-nested jsonl files outside the two pinned-depth shapes', async () => {
  await mkdir(join(dir, 'project-a', 'x', 'y', 'z'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'x', 'y', 'z', 'foo.jsonl'), '{"x":1}\n');

  const tooDeep = join(dir, 'project-b', 'sess', 'subagents', 'extra');
  await mkdir(tooDeep, { recursive: true });
  await writeFile(join(tooDeep, 'foo.jsonl'), '{"x":1}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  expect(found).toEqual([]);
});

test('captureSubAgents: true skips files at sub-agent path level (<project>/<session>/foo.jsonl) — not the supported shape', async () => {
  await mkdir(join(dir, 'project-a', 'session-dir'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'session-dir', 'stray.jsonl'), '{"x":1}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  expect(found).toEqual([]);
});

test('captureSubAgents: true combines parent and sub-agent files in a single result list', async () => {
  const projectDir = join(dir, 'project-a');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'session-1.jsonl'), '{"a":1}\n');
  await writeFile(join(projectDir, 'session-2.jsonl'), '{"b":2}\n');

  const sub1 = join(projectDir, 'session-1', 'subagents');
  const sub2 = join(projectDir, 'session-2', 'subagents');
  await mkdir(sub1, { recursive: true });
  await mkdir(sub2, { recursive: true });
  await writeFile(join(sub1, 'agent-1111.jsonl'), '{"agentId":"1111"}\n');
  await writeFile(join(sub2, 'agent-2222.jsonl'), '{"agentId":"2222"}\n');
  await writeFile(join(sub2, 'agent-3333.jsonl'), '{"agentId":"3333"}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  expect(found).toHaveLength(5);

  const uniquePaths = new Set(found.map((f) => f.sourcePath));
  expect(uniquePaths.size).toBe(5);
});

test('captureSubAgents: true applies minimumMtime to sub-agent files as well as parents', async () => {
  const projectDir = join(dir, 'project-a');
  await mkdir(projectDir, { recursive: true });
  const oldParent = join(projectDir, 'old-session.jsonl');
  const newParent = join(projectDir, 'new-session.jsonl');
  await writeFile(oldParent, '{"a":1}\n');
  await writeFile(newParent, '{"b":2}\n');

  const subagentsDir = join(projectDir, 'sess', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
  const oldSubagent = join(subagentsDir, 'agent-old.jsonl');
  const newSubagent = join(subagentsDir, 'agent-new.jsonl');
  await writeFile(oldSubagent, '{"agentId":"old"}\n');
  await writeFile(newSubagent, '{"agentId":"new"}\n');

  const ancient = new Date('2024-01-01T00:00:00Z');
  const recent = new Date();
  await utimes(oldParent, ancient, ancient);
  await utimes(oldSubagent, ancient, ancient);
  await utimes(newParent, recent, recent);
  await utimes(newSubagent, recent, recent);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverClaudeCodeFiles(dir, {
    minimumMtime: cutoff,
    captureSubAgents: true,
  });
  const paths = found.map((f) => f.sourcePath).toSorted();
  expect(paths).toEqual([newParent, newSubagent].toSorted());
});

test('captureSubAgents: true dedupes when the same file path is yielded across globs', async () => {
  const projectDir = join(dir, 'project-a');
  await mkdir(join(projectDir, 'sess', 'subagents'), { recursive: true });
  await writeFile(join(projectDir, 'session-1.jsonl'), '{"a":1}\n');
  await writeFile(join(projectDir, 'sess', 'subagents', 'agent-ff.jsonl'), '{"agentId":"ff"}\n');

  const found = await discoverClaudeCodeFiles(dir, { captureSubAgents: true });
  const paths = found.map((f) => f.sourcePath);
  expect(new Set(paths).size).toBe(paths.length);
});
