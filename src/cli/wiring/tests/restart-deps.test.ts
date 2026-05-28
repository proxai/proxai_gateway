import { expect, test } from 'bun:test';

import type { CommandResult } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit/writer.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildRestartDeps } from 'cli/wiring/restart-deps.ts';

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

const recreate: ServiceUnitRecreateConfig = {
  serviceUnitPath: '/tmp/x.plist',
  programPath: '/bin/p',
  platform: 'darwin',
};

const invokeSetup = (): Promise<CommandResult> => Promise.resolve({ exitCode: 0 });
const profileCtx = buildProfileContext('prod');

test('buildRestartDeps: wires service manager, recreate, and invokeSetup', () => {
  const deps = buildRestartDeps({
    serviceManager: sm,
    serviceUnitRecreate: recreate,
    invokeSetup,
    profileCtx,
  });
  expect(deps.serviceManager).toBe(sm);
  expect(deps.serviceUnitRecreate).toBe(recreate);
  expect(deps.invokeSetup).toBe(invokeSetup);
  expect(typeof deps.configExists).toBe('function');
});

test('buildRestartDeps: configExists() resolves to a boolean', async () => {
  const deps = buildRestartDeps({
    serviceManager: sm,
    serviceUnitRecreate: recreate,
    invokeSetup,
    profileCtx,
  });
  await expect(deps.configExists()).resolves.toEqual(expect.any(Boolean));
});
