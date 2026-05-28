import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { MIGRATED_MARKER } from 'core/io/fs/migrate-flat-to-nested.ts';
import { runDaemonStartupRelocation } from 'cli/commands/run/startup-relocation.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-startup-reloc-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

test('relocates legacy flat layout into prod/ subdirectory', async () => {
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.toml'), '[account]\n');
  writeFileSync(join(root, 'buffer.db'), '');

  await runDaemonStartupRelocation({ profileRootDir: () => root });

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(true);
  expect(existsSync(join(root, 'prod', 'buffer.db'))).toBe(true);
  expect(existsSync(join(root, 'config.toml'))).toBe(false);
});

test('is a no-op when migration marker already present', async () => {
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const prodDir = join(root, 'prod');
  mkdirSync(prodDir, { recursive: true });
  writeFileSync(join(root, MIGRATED_MARKER), 'migrated-at=2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(prodDir, 'config.toml'), '[account]\n');

  await runDaemonStartupRelocation({ profileRootDir: () => root });

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(prodDir, 'config.toml'))).toBe(true);
});
