import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPlatformServiceContext,
  buildProfileServiceContext,
  buildServiceUnitRecreate,
  platformServiceUnitPath,
  resolveWindowsUserId,
} from 'cli/wiring/platform.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { rmRecursive } from 'core/io/fs';

test('platformServiceUnitPath: darwin returns a non-empty plist path', () => {
  const path = platformServiceUnitPath('darwin');
  expect(typeof path).toBe('string');
  expect((path as string).length).toBeGreaterThan(0);
  expect(path).toContain('LaunchAgents');
});

test('platformServiceUnitPath: linux returns a non-empty systemd unit path', () => {
  const path = platformServiceUnitPath('linux');
  expect(typeof path).toBe('string');
  expect((path as string).length).toBeGreaterThan(0);
  expect(path).toContain('systemd');
});

test('platformServiceUnitPath: win32 returns a non-empty scheduled task xml path', () => {
  const path = platformServiceUnitPath('win32');
  expect(typeof path).toBe('string');
  expect((path as string).length).toBeGreaterThan(0);
});

test('platformServiceUnitPath: unsupported platform returns null', () => {
  expect(platformServiceUnitPath('aix')).toBe(null);
  expect(platformServiceUnitPath('freebsd')).toBe(null);
});

test('resolveWindowsUserId: returns DOMAIN\\USER when both are set', () => {
  expect(resolveWindowsUserId({ USERDOMAIN: 'CORP', USERNAME: 'alice' })).toBe('CORP\\alice');
});

test('resolveWindowsUserId: returns username when only USERNAME is set', () => {
  expect(resolveWindowsUserId({ USERNAME: 'bob' })).toBe('bob');
});

test('resolveWindowsUserId: returns username when domain is empty string', () => {
  expect(resolveWindowsUserId({ USERDOMAIN: '', USERNAME: 'carol' })).toBe('carol');
});

test('resolveWindowsUserId: returns undefined when both are missing', () => {
  expect(resolveWindowsUserId({})).toBeUndefined();
});

test('resolveWindowsUserId: returns undefined when USERNAME is empty', () => {
  expect(resolveWindowsUserId({ USERDOMAIN: 'CORP', USERNAME: '' })).toBeUndefined();
});

test('buildPlatformServiceContext: returns null on unsupported platform', () => {
  expect(buildPlatformServiceContext('aix', '/path/to/binary')).toBe(null);
});

test('buildPlatformServiceContext: returns context with platform/unitPath/serviceManager on darwin', () => {
  const ctx = buildPlatformServiceContext('darwin', '/path/to/binary');
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('darwin');
  expect(requireDefined(ctx).unitPath.length).toBeGreaterThan(0);
  expect(typeof requireDefined(ctx).serviceManager.isRunning).toBe('function');
});

test('buildPlatformServiceContext: works on linux', () => {
  const ctx = buildPlatformServiceContext('linux', '/path/to/binary');
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('linux');
});

test('buildPlatformServiceContext: works on win32', () => {
  const ctx = buildPlatformServiceContext('win32', 'C:\\bin\\proxai.exe');
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('win32');
});

let profileRootDir: string;
const origProfileRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];

beforeEach(() => {
  profileRootDir = mkdtempSync(join(tmpdir(), 'proxai-platform-'));
  process.env['PROXAI_TEST_PROFILE_ROOT'] = profileRootDir;
});

afterEach(async () => {
  if (origProfileRoot === undefined) {
    delete process.env['PROXAI_TEST_PROFILE_ROOT'];
  } else {
    process.env['PROXAI_TEST_PROFILE_ROOT'] = origProfileRoot;
  }
  await rmRecursive(profileRootDir);
});

test('buildProfileServiceContext: dev profile on darwin targets the dev launchd plist', () => {
  const devCtx = buildProfileContext('dev');
  const ctx = buildProfileServiceContext('darwin', '/path/to/binary', devCtx);
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('darwin');
  expect(requireDefined(ctx).unitPath).toContain('.dev');
  expect(typeof requireDefined(ctx).serviceManager.isRunning).toBe('function');

  const prodPath = requireDefined(
    buildPlatformServiceContext('darwin', '/path/to/binary'),
  ).unitPath;
  expect(prodPath).not.toContain('.dev');
});

test('buildProfileServiceContext: dev profile on linux targets the dev systemd unit', () => {
  const devCtx = buildProfileContext('dev');
  const ctx = buildProfileServiceContext('linux', '/path/to/binary', devCtx);
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('linux');
  expect(requireDefined(ctx).unitPath).toContain('-dev');

  const prodPath = requireDefined(buildPlatformServiceContext('linux', '/path/to/binary')).unitPath;
  expect(prodPath).not.toContain('-dev');
});

test('buildProfileServiceContext: dev profile on win32 targets the dev config dir scheduled task', () => {
  const devCtx = buildProfileContext('dev');
  const ctx = buildProfileServiceContext('win32', 'C:\\bin\\proxai.exe', devCtx);
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('win32');
  expect(requireDefined(ctx).unitPath).toContain(join('dev', 'scheduled-task.xml'));
  expect(requireDefined(ctx).unitPath).not.toContain(join('prod', 'scheduled-task.xml'));

  const prodCtx = buildProfileContext('prod');
  const prodPath = requireDefined(
    buildProfileServiceContext('win32', 'C:\\bin\\proxai.exe', prodCtx),
  ).unitPath;
  expect(prodPath).toContain(join('prod', 'scheduled-task.xml'));
});

test('buildProfileServiceContext: dev profile returns null on unsupported platform', () => {
  const devCtx = buildProfileContext('dev');
  expect(buildProfileServiceContext('freebsd', '/path/to/binary', devCtx)).toBe(null);
});

test('buildProfileServiceContext: prod profile delegates to the prod service context', () => {
  const prodCtx = buildProfileContext('prod');
  const ctx = buildProfileServiceContext('darwin', '/path/to/binary', prodCtx);
  expect(ctx).not.toBe(null);
  expect(requireDefined(ctx).platform).toBe('darwin');
  expect(requireDefined(ctx).unitPath).not.toContain('.dev');
});

test('buildProfileServiceContext: prod profile returns null on unsupported platform', () => {
  const prodCtx = buildProfileContext('prod');
  expect(buildProfileServiceContext('aix', '/path/to/binary', prodCtx)).toBe(null);
});

test('buildServiceUnitRecreate: omits windowsUserId on non-win32', () => {
  const recreate = buildServiceUnitRecreate(
    'darwin',
    '/Users/x/Library/LaunchAgents/x.plist',
    '/bin/p',
    {},
  );
  expect(recreate.platform).toBe('darwin');
  expect(recreate.serviceUnitPath).toBe('/Users/x/Library/LaunchAgents/x.plist');
  expect(recreate.programPath).toBe('/bin/p');
  expect('windowsUserId' in recreate).toBe(false);
});

test('buildServiceUnitRecreate: includes windowsUserId on win32 when env supports it', () => {
  const recreate = buildServiceUnitRecreate('win32', 'C:\\path\\task.xml', 'C:\\bin\\p.exe', {
    USERDOMAIN: 'CORP',
    USERNAME: 'alice',
  });
  expect(recreate.platform).toBe('win32');
  expect(recreate.windowsUserId).toBe('CORP\\alice');
});

test('buildServiceUnitRecreate: omits windowsUserId on win32 when env is empty', () => {
  const recreate = buildServiceUnitRecreate('win32', 'C:\\path\\task.xml', 'C:\\bin\\p.exe', {});
  expect(recreate.platform).toBe('win32');
  expect('windowsUserId' in recreate).toBe(false);
});

test('buildServiceUnitRecreate: defaults profileName to prod when not provided', () => {
  const recreate = buildServiceUnitRecreate(
    'darwin',
    '/Users/x/Library/LaunchAgents/x.plist',
    '/bin/p',
    {},
  );
  expect(recreate.profileName).toBe('prod');
});

test('buildServiceUnitRecreate: sets profileName to dev when passed', () => {
  const recreate = buildServiceUnitRecreate(
    'darwin',
    '/Users/x/Library/LaunchAgents/x.plist',
    '/bin/p',
    {},
    'dev',
  );
  expect(recreate.profileName).toBe('dev');
});

test('buildServiceUnitRecreate: preserves windowsUserId alongside profileName on win32', () => {
  const recreate = buildServiceUnitRecreate(
    'win32',
    'C:\\path\\task.xml',
    'C:\\bin\\p.exe',
    { USERDOMAIN: 'CORP', USERNAME: 'alice' },
    'dev',
  );
  expect(recreate.windowsUserId).toBe('CORP\\alice');
  expect(recreate.profileName).toBe('dev');
});
