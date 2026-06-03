import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('forwards windowsUserId to writer on win32 platform', async () => {
  const unitPath = join(dir, 'co.proxai.gateway.xml');
  const programPath = join(dir, 'proxai-gateway');
  writeFileSync(unitPath, 'legacy content without profile');

  await refreshServiceUnitIfLegacy({
    serviceUnitPath: unitPath,
    programPath,
    platform: 'win32',
    profileName: 'prod',
    windowsUserId: 'mock-user-123',
  });

  const updated = readFileSync(unitPath, 'utf16le');
  expect(updated).toContain('--profile');
  expect(updated).toContain('mock-user-123');
});

test('rewrites a plist that has --profile but points at an outdated programPath', async () => {
  const unitPath = join(dir, 'co.proxai.gateway.plist');
  const newProgramPath = join(dir, 'proxai-gateway-new');
  const oldProgramPath = join(dir, 'proxai-gateway-old');
  const body = buildLaunchdPlist({
    programPath: oldProgramPath,
    programArgs: ['run', '--profile', 'prod'],
  });
  writeFileSync(unitPath, body);

  await refreshServiceUnitIfLegacy({
    serviceUnitPath: unitPath,
    programPath: newProgramPath,
    platform: 'darwin',
    profileName: 'prod',
  });

  const updated = readFileSync(unitPath, 'utf8');
  expect(updated).toContain(newProgramPath);
  expect(updated).not.toContain(oldProgramPath);
});

test('does not throw when the service unit cannot be rewritten', async () => {
  const unitDir = join(dir, 'unit-as-dir');
  mkdirSync(unitDir);
  const unitPath = join(unitDir, 'co.proxai.gateway.plist');
  writeFileSync(
    unitPath,
    buildLaunchdPlist({ programPath: join(dir, 'old'), programArgs: ['run'] }),
  );
  rmSync(unitPath);
  mkdirSync(unitPath);

  await expect(
    refreshServiceUnitIfLegacy({
      serviceUnitPath: unitPath,
      programPath: join(dir, 'new'),
      platform: 'darwin',
      profileName: 'prod',
    }),
  ).resolves.toBeUndefined();
});
