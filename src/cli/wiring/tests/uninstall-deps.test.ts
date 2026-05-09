import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager';
import { buildUninstallDeps, buildUninstallOptions } from 'cli/wiring/uninstall-deps.ts';

const sm = {
  ensureRegistered: async () => {},
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  unregister: async () => {},
  isRegistered: async () => false,
  isRunning: async () => false,
  runtimeInfo: async () => ({ pid: null, startedAt: null }),
} satisfies ServiceManager;

test('buildUninstallDeps: wires sweep + binaryRemover + pathCleaner + installDir', () => {
  const deps = buildUninstallDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: '/tmp/x.plist',
    serviceManager: sm,
  });
  expect(deps.serviceManager).toBe(sm);
  expect(deps.serviceUnitPath).toBe('/tmp/x.plist');
  expect(deps.currentExecPath).toBe('/bin/p');
  expect(deps.sweep).toBeDefined();
  expect(deps.binaryRemover).toBeDefined();
  expect(deps.pathCleaner).toBeDefined();
  expect(deps.installDir).toContain('.proxai');
});

test('buildUninstallDeps: works for all supported platforms', () => {
  for (const p of ['darwin', 'linux', 'win32'] as const) {
    const deps = buildUninstallDeps({
      platform: p,
      programPath: '/bin/p',
      serviceUnitPath: '/tmp/x',
      serviceManager: sm,
    });
    expect(deps.binaryRemover).toBeDefined();
    expect(deps.pathCleaner).toBeDefined();
  }
});

test('buildUninstallOptions: forwards reset/yes flags when true', () => {
  expect(buildUninstallOptions({ reset: true, yes: true })).toEqual({ reset: true, yes: true });
});

test('buildUninstallOptions: omits flags when false or undefined', () => {
  expect(buildUninstallOptions({})).toEqual({});
});

test('buildUninstallDeps: configExists() resolves to a boolean', async () => {
  const deps = buildUninstallDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: '/tmp/x',
    serviceManager: sm,
  });
  await expect(deps.configExists()).resolves.toEqual(expect.any(Boolean));
});
