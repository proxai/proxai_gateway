import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDir, setMode } from 'core/io/fs/mode.ts';
import { rmRecursive } from 'core/io/fs/rm-recursive.ts';

let mockDirnameSelf = false;

mock.module('node:path', () => {
  const actual = require('node:path');
  return {
    ...actual,
    dirname: (p: string) => {
      if (mockDirnameSelf) return p;
      return actual.dirname(p);
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-mode-test-'));
});

afterEach(async () => {
  await rmRecursive(dir);
  delete process.env['PROXAI_TEST_PROFILE_ROOT'];
});

test('ensureDir creates directory and sets permissions', async () => {
  const target = join(dir, 'nested-dir');
  await ensureDir(target, 0o755);
  expect(existsSync(target)).toBe(true);

  if (process.platform !== 'win32') {
    const s = statSync(target);
    expect(s.mode & 0o777).toBe(0o755);
  }
});

test('ensureDir clamps base profile directory to 0o700 when path is inside it', async () => {
  if (process.platform === 'win32') return;

  const profileRoot = join(dir, 'profile-root-clamp');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = profileRoot;

  const target = join(profileRoot, 'prod', 'buffers');
  await ensureDir(target, 0o755);

  expect(existsSync(target)).toBe(true);
  expect(existsSync(profileRoot)).toBe(true);

  const rootStat = statSync(profileRoot);
  expect(rootStat.mode & 0o777).toBe(0o700);

  const targetStat = statSync(target);
  expect(targetStat.mode & 0o777).toBe(0o755);
});

test('setMode changes directory permissions', async () => {
  if (process.platform === 'win32') return;

  const target = join(dir, 'setmode-dir');
  mkdirSync(target);

  await setMode(target, 0o600);
  const s = statSync(target);
  expect(s.mode & 0o777).toBe(0o600);
});

test('ensureSecureBaseDirs secures directory and any parent directory containing ProxAI', async () => {
  if (process.platform === 'win32') return;

  const { ensureSecureBaseDirs } = await import('core/io/fs/mode.ts');
  const orgDir = join(dir, 'ProxAI');
  const targetDir = join(orgDir, 'proxai-gateway', 'prod');

  await ensureSecureBaseDirs(targetDir);

  expect(existsSync(targetDir)).toBe(true);
  expect(existsSync(orgDir)).toBe(true);

  const orgStat = statSync(orgDir);
  expect(orgStat.mode & 0o777).toBe(0o700);

  const targetStat = statSync(targetDir);
  expect(targetStat.mode & 0o777).toBe(0o700);
});

test('ensureSecureBaseDirs clamps pre-existing parent directories containing ProxAI', async () => {
  if (process.platform === 'win32') return;

  const { ensureSecureBaseDirs } = await import('core/io/fs/mode.ts');
  const orgDir = join(dir, 'ProxAI');
  mkdirSync(orgDir);
  await setMode(orgDir, 0o755);

  const targetDir = join(orgDir, 'proxai-gateway', 'prod');
  await ensureSecureBaseDirs(targetDir);

  const orgStat = statSync(orgDir);
  expect(orgStat.mode & 0o777).toBe(0o700);

  const targetStat = statSync(targetDir);
  expect(targetStat.mode & 0o777).toBe(0o700);
});

test('ensureSecureBaseDirs on win32 platform returns early', async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });
  try {
    const { ensureSecureBaseDirs } = await import('core/io/fs/mode.ts');
    const targetDir = join(dir, 'ProxAI', 'gateway');
    await ensureSecureBaseDirs(targetDir);
    expect(existsSync(targetDir)).toBe(true);
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  }
});

test('ensureSecureBaseDirs breaks when parent === current', async () => {
  if (process.platform === 'win32') return;

  const { ensureSecureBaseDirs } = await import('core/io/fs/mode.ts');
  const orgDir = join(dir, 'ProxAI');
  const targetDir = join(orgDir, 'gateway');

  mockDirnameSelf = true;
  try {
    await ensureSecureBaseDirs(targetDir);
    expect(existsSync(targetDir)).toBe(true);
  } finally {
    mockDirnameSelf = false;
  }
});
