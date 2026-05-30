import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultGeminiCliTmpRoot, discoverGeminiCliFiles } from 'sources/gemini-cli';

function sortedPaths(xs: Awaited<ReturnType<typeof discoverGeminiCliFiles>>): string[] {
  return xs.map((f) => f.sourcePath).toSorted();
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-cli-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('returns empty list when the tmp directory does not exist', async () => {
  const found = await discoverGeminiCliFiles(join(dir, 'no-such-dir'));
  expect(found).toEqual([]);
});

test('returns empty list when the tmp directory exists but has no chats', async () => {
  const found = await discoverGeminiCliFiles(dir);
  expect(found).toEqual([]);
});

test('discovers top-level main session files under <project>/chats', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  await mkdir(join(dir, 'project-b', 'chats'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'chats', 'session-2026-01-01-aaa.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'project-b', 'chats', 'session-2026-01-02-bbb.jsonl'), '{"b":2}\n');

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(2);
});

test('discovers nested subagent session files under <project>/chats/<sessionUUID>/', async () => {
  await mkdir(join(dir, 'project-a', 'chats', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), {
    recursive: true,
  });
  await writeFile(join(dir, 'project-a', 'chats', 'session-2026-01-01-aaa.jsonl'), '{"a":1}\n');
  await writeFile(
    join(dir, 'project-a', 'chats', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'subagent.jsonl'),
    '{"sub":1}\n',
  );

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(2);
  const paths = found.map((f) => f.sourcePath).toSorted();
  expect(paths[0]).toContain(join('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'subagent.jsonl'));
  expect(paths[1]).toContain('session-2026-01-01-aaa.jsonl');
});

test('skips files outside the chats directory', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'chats', 'session.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'project-a', 'settings.json'), '{}');
  await writeFile(join(dir, 'top-level.jsonl'), '{"x":1}\n');

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(1);
  expect(requireDefined(found[0]).sourcePath).toContain('chats');
});

test('skips non-jsonl files inside chats', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'chats', 'session.jsonl'), '{"a":1}\n');
  await writeFile(join(dir, 'project-a', 'chats', 'README.md'), '# notes');

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(1);
});

test('returns size, inode, mtime, and sha256 hash for each file', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'chats', 'session.jsonl'), '{"a":1}\n');

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(1);
  expect(requireDefined(found[0]).sizeBytes).toBe(8);
  expect(requireDefined(found[0]).inode).toBeGreaterThan(0);
  expect(requireDefined(found[0]).lastModifiedMs).toBeGreaterThan(0);
  expect(requireDefined(found[0]).sourcePathHash).toMatch(/^[a-f0-9]{64}$/);
});

test('skips files older than minimumMtime, keeps newer ones', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'chats', 'old.jsonl');
  const newPath = join(dir, 'project-a', 'chats', 'new.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  await writeFile(newPath, '{"b":2}\n');

  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  const newEpoch = new Date();
  await utimes(oldPath, oldEpoch, oldEpoch);
  await utimes(newPath, newEpoch, newEpoch);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const found = await discoverGeminiCliFiles(dir, { minimumMtime: cutoff });
  expect(found).toHaveLength(1);
  expect(requireDefined(found[0]).sourcePath).toBe(newPath);
});

test('null minimumMtime means no cap (all files included)', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'chats', 'old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverGeminiCliFiles(dir, { minimumMtime: null });
  expect(found).toHaveLength(1);
});

test('omitting options means no cap (defaults preserved)', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  const oldPath = join(dir, 'project-a', 'chats', 'old.jsonl');
  await writeFile(oldPath, '{"a":1}\n');
  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  await utimes(oldPath, oldEpoch, oldEpoch);

  const found = await discoverGeminiCliFiles(dir);
  expect(found).toHaveLength(1);
});

test('defaultGeminiCliTmpRoot returns homedir joined with gemini tmp subpath', () => {
  const result = defaultGeminiCliTmpRoot();
  const expected = join(homedir(), '.gemini', 'tmp');
  expect(result).toBe(expected);
});

test('discovery result is identical regardless of PROXAI_GATEWAY_CAPTURE_SUB_AGENTS env (no-op flag)', async () => {
  await mkdir(join(dir, 'project-a', 'chats'), { recursive: true });
  await writeFile(join(dir, 'project-a', 'chats', 'session-2026-01-01-aaa.jsonl'), '{"a":1}\n');

  const originalGlobal = process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS;
  const originalSource = process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI;
  try {
    delete process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS;
    delete process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI;
    const offRun = await discoverGeminiCliFiles(dir);

    process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI = '1';
    const onRun = await discoverGeminiCliFiles(dir);

    process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS = '1';
    const onGlobalRun = await discoverGeminiCliFiles(dir);

    expect(sortedPaths(offRun)).toEqual(sortedPaths(onRun));
    expect(sortedPaths(offRun)).toEqual(sortedPaths(onGlobalRun));
  } finally {
    if (originalGlobal === undefined) {
      delete process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS;
    } else {
      process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS = originalGlobal;
    }
    if (originalSource === undefined) {
      delete process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI;
    } else {
      process.env.PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI = originalSource;
    }
  }
});
