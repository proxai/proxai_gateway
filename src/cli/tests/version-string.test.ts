import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatVersionString,
  parseInstallSourceFromToml,
  readInstallSourceSync,
} from 'cli/version-string.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-version-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('formatVersionString includes app name, version, and install source', () => {
  expect(formatVersionString('2026.5.9-3', 'npm')).toBe(
    'proxai-gateway 2026.5.9-3\ninstalled via npm',
  );
  expect(formatVersionString('2026.5.9-3', 'unknown')).toBe(
    'proxai-gateway 2026.5.9-3\ninstalled via unknown',
  );
});

test('parseInstallSourceFromToml returns the recognized source when present', () => {
  const sources = ['bun', 'pnpm', 'yarn', 'npm', 'brew', 'github_release'] as const;
  for (const v of sources) {
    expect(parseInstallSourceFromToml(`install_source = "${v}"`)).toBe(v);
  }
});

test('parseInstallSourceFromToml returns unknown when missing or unrecognized', () => {
  expect(parseInstallSourceFromToml('# no source here')).toBe('unknown');
  expect(parseInstallSourceFromToml('install_source = "evil"')).toBe('unknown');
});

test('readInstallSourceSync returns unknown when config file does not exist', () => {
  expect(readInstallSourceSync(join(dir, 'missing.toml'))).toBe('unknown');
});

test('readInstallSourceSync extracts the install_source from a real config file', async () => {
  const configPath = join(dir, 'config.toml');
  await writeFile(
    configPath,
    [
      '[account]',
      'api_key = "x"',
      'user_id = "y"',
      'host_id = "z"',
      'installed_at = "2026-05-08T00:00:00Z"',
      'install_source = "npm"',
      '',
    ].join('\n'),
  );
  expect(readInstallSourceSync(configPath)).toBe('npm');
});

test('readInstallSourceSync returns unknown for an empty file', async () => {
  const configPath = join(dir, 'empty.toml');
  await writeFile(configPath, '');
  expect(readInstallSourceSync(configPath)).toBe('unknown');
});
