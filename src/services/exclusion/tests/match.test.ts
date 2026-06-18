// src/services/exclusion/tests/match.test.ts
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProjectExcluded, normalizeFolderPath } from 'services/exclusion/match.ts';

test('empty exclusion list never matches', () => {
  expect(isProjectExcluded('/Users/me/p', [])).toBe(false);
});

test('exact folder match', () => {
  expect(isProjectExcluded('/Users/me/secret', ['/Users/me/secret'])).toBe(true);
});

test('nested folder is excluded', () => {
  expect(isProjectExcluded('/Users/me/secret/sub', ['/Users/me/secret'])).toBe(true);
});

test('sibling with shared prefix is NOT excluded (boundary anchored)', () => {
  expect(isProjectExcluded('/Users/me/secret-2', ['/Users/me/secret'])).toBe(false);
});

test('trailing slash on pattern is ignored', () => {
  expect(isProjectExcluded('/Users/me/secret', ['/Users/me/secret/'])).toBe(true);
});

test('leading ~ in pattern expands to home', () => {
  const folder = join(homedir(), 'Documents', 'x');
  expect(isProjectExcluded(folder, ['~/Documents/x'])).toBe(true);
});

test('case-insensitive match on macOS', () => {
  if (process.platform !== 'darwin') return;
  expect(isProjectExcluded('/Users/Me/Secret', ['/users/me/secret'])).toBe(true);
});

test('normalizeFolderPath is idempotent', () => {
  const once = normalizeFolderPath('/a/b/');
  expect(normalizeFolderPath(once)).toBe(once);
});

test('whitespace-only or empty pattern never matches', () => {
  expect(isProjectExcluded('/Users/me/project', ['  '])).toBe(false);
  expect(isProjectExcluded('/Users/me/project', [''])).toBe(false);
});

test('normalizeFolderPath maps empty/whitespace input to "" (not the daemon cwd)', () => {
  expect(normalizeFolderPath('')).toBe('');
  expect(normalizeFolderPath('   ')).toBe('');
});

test('whitespace-only folder does not match even the daemon cwd', () => {
  // Before the empty-input fix, normalizeFolderPath('   ') resolved to process.cwd(),
  // so a junk-cwd chat would spuriously match a daemon running inside an excluded folder.
  expect(isProjectExcluded('   ', [process.cwd()])).toBe(false);
});

test('symlinked project path matches the real excluded path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-symlink-'));
  try {
    const real = join(dir, 'real-project');
    const link = join(dir, 'link-project');
    await mkdir(real);
    await symlink(real, link);
    // Excluding via the symlinked path must still match a real cwd, and vice versa.
    expect(isProjectExcluded(real, [link])).toBe(true);
    expect(isProjectExcluded(link, [real])).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
