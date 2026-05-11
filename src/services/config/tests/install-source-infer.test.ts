import { expect, test } from 'bun:test';

import { inferInstallSource } from 'services/config';

test('detects github_release from $HOME/.proxai/bin path', () => {
  expect(inferInstallSource('/Users/x/.proxai/bin/proxai-gateway', 'darwin')).toBe(
    'github_release',
  );
});

test('detects brew from homebrew Cellar path', () => {
  expect(
    inferInstallSource('/opt/homebrew/Cellar/proxai-gateway/2026.5.8/bin/proxai-gateway', 'darwin'),
  ).toBe('brew');
});

test('detects brew from linuxbrew path', () => {
  expect(inferInstallSource('/home/linuxbrew/.linuxbrew/bin/proxai-gateway', 'linux')).toBe('brew');
});

test('detects bun from $HOME/.bun/install/global path', () => {
  expect(
    inferInstallSource(
      '/Users/x/.bun/install/global/node_modules/@proxai/gateway/dist/main',
      'darwin',
    ),
  ).toBe('bun');
});

test('detects pnpm from /pnpm/ path', () => {
  expect(
    inferInstallSource(
      '/Users/x/Library/pnpm/global/5/node_modules/@proxai/gateway/dist/main',
      'darwin',
    ),
  ).toBe('pnpm');
});

test('detects pnpm from /.pnpm/ path', () => {
  expect(
    inferInstallSource('/Users/x/.pnpm/global/5/node_modules/@proxai/gateway/dist/main', 'darwin'),
  ).toBe('pnpm');
});

test('detects yarn from yarn global path', () => {
  expect(
    inferInstallSource('/Users/x/.yarn/global/node_modules/@proxai/gateway/dist/main', 'darwin'),
  ).toBe('yarn');
});

test('detects yarn from /yarn/global/ path', () => {
  expect(
    inferInstallSource(
      '/usr/local/lib/yarn/global/node_modules/@proxai/gateway/dist/main',
      'linux',
    ),
  ).toBe('yarn');
});

test('detects npm from node_modules/@proxai path', () => {
  expect(inferInstallSource('/usr/local/lib/node_modules/@proxai/gateway/dist/main', 'linux')).toBe(
    'npm',
  );
});

test('handles Windows backslashes and APPDATA bun path', () => {
  expect(
    inferInstallSource(
      'C:\\Users\\test\\.bun\\install\\global\\node_modules\\@proxai\\gateway\\dist\\main.exe',
      'win32',
    ),
  ).toBe('bun');
});

test('falls back to github_release when no pattern matches', () => {
  expect(inferInstallSource('/some/random/path/binary', 'linux')).toBe('github_release');
});

test('uses process.platform when platform omitted', () => {
  expect(typeof inferInstallSource('/Users/x/.bun/install/global/x')).toBe('string');
});
