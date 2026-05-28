import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildLaunchdPlist } from 'cli/service-unit/launchd-plist.ts';
import { refreshServiceUnitIfLegacy } from 'cli/commands/run/service-unit-refresh.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-sunit-refresh-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

test('rewrites a legacy plist that lacks --profile', async () => {
  const unitPath = join(dir, 'co.proxai.gateway.plist');
  const programPath = join(dir, 'proxai-gateway');
  const legacyBody = buildLaunchdPlist({ programPath, programArgs: ['run'] });
  writeFileSync(unitPath, legacyBody);

  await refreshServiceUnitIfLegacy({
    serviceUnitPath: unitPath,
    programPath,
    platform: 'darwin',
    profileName: 'prod',
  });

  const updated = readFileSync(unitPath, 'utf8');
  expect(updated).toContain('--profile');
  expect(updated).toContain('prod');
});

test('leaves a plist that already contains --profile byte-identical', async () => {
  const unitPath = join(dir, 'co.proxai.gateway.plist');
  const programPath = join(dir, 'proxai-gateway');
  const modernBody = buildLaunchdPlist({ programPath, programArgs: ['run', '--profile', 'prod'] });
  writeFileSync(unitPath, modernBody);

  const beforeSize = readFileSync(unitPath).byteLength;
  await refreshServiceUnitIfLegacy({
    serviceUnitPath: unitPath,
    programPath,
    platform: 'darwin',
    profileName: 'prod',
  });

  const afterBody = readFileSync(unitPath);
  expect(afterBody.byteLength).toBe(beforeSize);
  expect(readFileSync(unitPath, 'utf8')).toBe(modernBody);
});

test('no-ops when the unit file does not exist', async () => {
  const unitPath = join(dir, 'does-not-exist.plist');
  const programPath = join(dir, 'proxai-gateway');

  await expect(
    refreshServiceUnitIfLegacy({
      serviceUnitPath: unitPath,
      programPath,
      platform: 'darwin',
      profileName: 'prod',
    }),
  ).resolves.toBeUndefined();
});
