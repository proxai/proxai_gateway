import { expect, test } from 'bun:test';

import {
  buildPlatformServiceContext,
  buildServiceUnitRecreate,
  platformServiceUnitPath,
  resolveWindowsUserId,
} from 'cli/wiring/platform.ts';

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
  expect(ctx!.platform).toBe('darwin');
  expect(ctx!.unitPath.length).toBeGreaterThan(0);
  expect(typeof ctx!.serviceManager.isRunning).toBe('function');
});

test('buildPlatformServiceContext: works on linux', () => {
  const ctx = buildPlatformServiceContext('linux', '/path/to/binary');
  expect(ctx).not.toBe(null);
  expect(ctx!.platform).toBe('linux');
});

test('buildPlatformServiceContext: works on win32', () => {
  const ctx = buildPlatformServiceContext('win32', 'C:\\bin\\proxai.exe');
  expect(ctx).not.toBe(null);
  expect(ctx!.platform).toBe('win32');
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
