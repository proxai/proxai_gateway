import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

import packageJson from '../../package.json' with { type: 'json' };

const REPO_ROOT = resolve(import.meta.dir, '../..');

test('scripts/build.ts exists', async () => {
  expect(await Bun.file(resolve(REPO_ROOT, 'scripts/build.ts')).exists()).toBe(true);
});

test('package.json wires the top-level build script', () => {
  expect(packageJson.scripts.build).toBe('bun scripts/build.ts');
});

test('package.json wires per-target build scripts for every supported platform', () => {
  const expectedTargets = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'windows-x64',
    'windows-arm64',
  ];
  const scripts = packageJson.scripts as Record<string, string>;
  for (const target of expectedTargets) {
    const key = `build:${target}`;
    expect(scripts[key]).toBe(`bun scripts/build.ts ${target}`);
  }
});
