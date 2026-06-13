import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import { discoverGeminiConversations } from 'sources/gemini';
import {
  defaultGeminiCliConversationsDir,
  defaultGeminiIdeConversationsDir,
  geminiPlatformForRoot,
} from 'sources/gemini/source-platform.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

test('discovers .db files and ignores other extensions', async () => {
  await Bun.write(join(dir, 'a.db'), 'one');
  await Bun.write(join(dir, 'b.db'), 'two');
  await Bun.write(join(dir, 'history.jsonl'), 'noise');
  await Bun.write(join(dir, 'notes.txt'), 'noise');

  const files = await discoverGeminiConversations(dir, { sourcePlatform: 'antigravity-cli' });
  expect(files.length).toBe(2);
  for (const file of files) {
    expect(file.sourcePath.endsWith('.db')).toBe(true);
    expect(file.sourcePathHash).toBe(sha256Hex(file.sourcePath));
    expect(file.sourcePlatform).toBe('antigravity-cli');
    expect(Number.isFinite(file.inode)).toBe(true);
  }
});

test('tags discovered files with the requested ide platform', async () => {
  await Bun.write(join(dir, 'c.db'), 'x');
  const files = await discoverGeminiConversations(dir, { sourcePlatform: 'antigravity-ide' });
  expect(files.length).toBe(1);
  expect(files[0]?.sourcePlatform).toBe('antigravity-ide');
});

test('respects the minimumMtime filter', async () => {
  await Bun.write(join(dir, 'recent.db'), 'x');

  const future = new Date(Date.now() + 60_000);
  const excluded = await discoverGeminiConversations(dir, {
    minimumMtime: future,
    sourcePlatform: 'antigravity-cli',
  });
  expect(excluded.length).toBe(0);

  const included = await discoverGeminiConversations(dir, {
    minimumMtime: new Date(0),
    sourcePlatform: 'antigravity-cli',
  });
  expect(included.length).toBe(1);
});

test('returns an empty list for a missing base directory', async () => {
  const files = await discoverGeminiConversations(join(dir, 'does-not-exist'), {
    sourcePlatform: 'antigravity-cli',
  });
  expect(files).toEqual([]);
});

test('default conversation dirs are home-relative and platform mapping is stable', () => {
  const home = homedir();
  const cliExpected = join(home, '.gemini', 'antigravity-cli', 'conversations');
  const ideExpected = join(home, '.gemini', 'antigravity-ide', 'conversations');
  expect(defaultGeminiCliConversationsDir()).toBe(cliExpected);
  expect(defaultGeminiIdeConversationsDir()).toBe(ideExpected);
  expect(defaultGeminiCliConversationsDir().includes(`${sep}.gemini${sep}`)).toBe(true);
  expect(geminiPlatformForRoot('cli')).toBe('antigravity-cli');
  expect(geminiPlatformForRoot('ide')).toBe('antigravity-ide');
});
