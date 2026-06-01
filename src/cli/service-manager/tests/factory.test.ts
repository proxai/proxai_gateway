import { expect, test } from 'bun:test';
import { getServiceManager } from 'cli/service-manager';
import type { SpawnFn } from 'cli/service-manager';
import { mockSpawn } from './mock-spawn.ts';

test('unsupported platform throws clear error in getServiceManager', () => {
  expect(() =>
    getServiceManager({
      platform: 'aix' as NodeJS.Platform,
      unitPath: '/x',
    }),
  ).toThrow(/unsupported platform/);
});

test('getServiceManager builds launchctl manager for darwin', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/path/to/unit.plist',
    spawn,
    profile: 'dev',
  });
  expect(sm).toBeDefined();

  // Test wrapping methods delegation and success states
  await expect(sm.isRegistered()).resolves.toBe(true);
  await expect(sm.isRunning()).resolves.toBe(false);
  await expect(sm.runtimeInfo()).resolves.toEqual({ pid: null, startedAt: null });

  await sm.ensureRegistered();
  await sm.start();
  await sm.stop();
  await sm.restart();
  await sm.unregister();
});

test('getServiceManager builds systemctl manager for linux', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/path/to/unit.service',
    spawn,
    profile: 'prod',
  });
  expect(sm).toBeDefined();
  await sm.ensureRegistered();
});

test('getServiceManager builds schtasks manager for win32', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: '/path/to/unit.xml',
    spawn,
    profile: 'prod',
  });
  expect(sm).toBeDefined();
  await sm.ensureRegistered();
});

test('wrapWithMachine handles error throws gracefully with Error object', async () => {
  // We test the error wrapping logic by manually passing custom inner manager
  // But wait, getServiceManager doesn't let us pass an arbitrary inner manager.
  // Wait, we can test it by making the mock spawn function throw or fail,
  // which will cause the inner manager (e.g. launchctl/systemctl) to throw an Error!
  // Let's do that to trigger error flows on each wrapped method.
  const { spawn } = mockSpawn(() => {
    throw new Error('spawn-failed');
  });

  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/path/to/unit.plist',
    spawn,
  });

  await expect(sm.ensureRegistered()).rejects.toThrow('spawn-failed');
  await expect(sm.start()).rejects.toThrow('spawn-failed');
  await expect(sm.stop()).rejects.toThrow('spawn-failed');
  await expect(sm.restart()).rejects.toThrow('spawn-failed');
  await expect(sm.unregister()).rejects.toThrow('spawn-failed');
});

test('getServiceManager returns a no-op manager under PROXAI_TEST_PROFILE_ROOT without an injected spawn', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  process.env['PROXAI_TEST_PROFILE_ROOT'] = '/tmp/proxai-noop-sandbox';
  try {
    const sm = getServiceManager({ platform: 'darwin', unitPath: '/path/to/unit.plist' });
    await expect(sm.isRegistered()).resolves.toBe(false);
    await expect(sm.isRunning()).resolves.toBe(false);
    await expect(sm.runtimeInfo()).resolves.toEqual({ pid: null, startedAt: null });
    await sm.ensureRegistered();
    await sm.start();
    await sm.stop();
    await sm.restart();
    await sm.unregister();
  } finally {
    if (original === undefined) delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    else process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
  }
});

test('wrapWithMachine handles non-Error object throws gracefully', async () => {
  // To throw a non-Error, we can make spawn throw a raw string.
  const spawn: SpawnFn = () => {
    throw 'spawn-string-failed';
  };

  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/path/to/unit.plist',
    spawn,
  });

  await expect(sm.ensureRegistered()).rejects.toBe('spawn-string-failed');
});
