import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { isLocalBuildPath } from 'services/upgrade/local-build.ts';

test('isLocalBuildPath is false for an undefined path', () => {
  expect(isLocalBuildPath(undefined)).toBe(false);
});

test('isLocalBuildPath is true for a path under a dist segment', () => {
  expect(isLocalBuildPath(join('repo', 'dist', 'darwin-arm64', 'proxai-gateway'))).toBe(true);
});

test('isLocalBuildPath is false for production install locations', () => {
  expect(isLocalBuildPath(join('home', '.proxai', 'bin', 'proxai-gateway'))).toBe(false);
  expect(
    isLocalBuildPath(join('node_modules', '@proxai', 'gateway', 'bin', 'proxai-gateway')),
  ).toBe(false);
});
