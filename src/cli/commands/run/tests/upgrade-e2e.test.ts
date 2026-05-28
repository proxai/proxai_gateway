import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { MIGRATED_MARKER } from 'core/io/fs/migrate-flat-to-nested.ts';
import { buildLaunchdPlist } from 'cli/service-unit/launchd-plist.ts';
import { runDaemonStartupRelocation } from 'cli/commands/run/startup-relocation.ts';
import { refreshServiceUnitIfLegacy } from 'cli/commands/run/service-unit-refresh.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxai-upgrade-e2e-'));
});

afterEach(async () => {
  await rmRecursive(root);
}, 30_000);

test('legacy flat install relocates and rewrites its service unit on first start', async () => {
  writeFileSync(join(root, 'config.toml'), '[account]\napi_key = "x"\n');
  writeFileSync(join(root, 'buffer.db'), 'db');
  writeFileSync(join(root, 'AUTH_FAILED'), 'auth');
  const programPath = join(root, 'proxai-gateway');
  const unitPath = join(root, 'co.proxai.gateway.plist');
  writeFileSync(unitPath, buildLaunchdPlist({ programPath, programArgs: ['run'] }));

  await runDaemonStartupRelocation({ profileRootDir: () => root });
  await refreshServiceUnitIfLegacy({
    serviceUnitPath: unitPath,
    programPath,
    platform: 'darwin',
    profileName: 'prod',
  });

  expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(true);
  expect(existsSync(join(root, 'prod', 'buffer.db'))).toBe(true);
  expect(existsSync(join(root, 'prod', 'AUTH_FAILED'))).toBe(true);
  expect(existsSync(join(root, 'config.toml'))).toBe(false);
  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);

  const plist = readFileSync(unitPath, 'utf8');
  expect(plist).toContain('--profile');
  expect(plist).toContain('prod');

  const prodCtx = buildProfileContext('prod');
  expect(prodCtx.bufferDbPath.endsWith(join('prod', 'buffer.db'))).toBe(true);
});
