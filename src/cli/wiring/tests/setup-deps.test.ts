import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager';
import {
  buildSetupDeps,
  buildSetupOptions,
  invokeSetupInteractive,
} from 'cli/wiring/setup-deps.ts';

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

test('buildSetupDeps: omits serviceManager when null and platform=darwin', () => {
  const deps = buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
  });
  expect(deps.platform).toBe('darwin');
  expect(deps.serviceUnitPath).toBe(null);
  expect('serviceManager' in deps).toBe(false);
  expect('windowsUserId' in deps).toBe(false);
});

test('buildSetupDeps: includes serviceManager when provided', () => {
  const deps = buildSetupDeps({
    platform: 'linux',
    programPath: '/bin/p',
    serviceUnitPath: '/tmp/x.service',
    serviceManager: sm,
    env: {},
  });
  expect(deps.serviceManager).toBe(sm);
  expect(deps.serviceUnitPath).toBe('/tmp/x.service');
});

test('buildSetupDeps: configExists() resolves with a boolean', async () => {
  const deps = buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
  });
  await expect(deps.configExists()).resolves.toEqual(expect.any(Boolean));
});

test('buildSetupDeps: httpClientFactory returns a working HttpClient', () => {
  const deps = buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
  });
  const client = deps.httpClientFactory('test-key', 'test-host');
  expect(client).toBeDefined();
});

test('buildSetupDeps: readMachineUuid resolves to a string', async () => {
  const deps = buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
  });
  expect(deps.readMachineUuid).toBeDefined();
  const reader = deps.readMachineUuid;
  if (reader === undefined) throw new Error('readMachineUuid not wired');
  const uuid = await reader();
  expect(typeof uuid).toBe('string');
  expect(uuid.length).toBeGreaterThan(0);
});

test('buildSetupDeps: sets windowsUserId on win32 when env supports it', () => {
  const deps = buildSetupDeps({
    platform: 'win32',
    programPath: 'C:\\bin\\p.exe',
    serviceUnitPath: 'C:\\tmp\\x.xml',
    serviceManager: sm,
    env: { USERDOMAIN: 'CORP', USERNAME: 'alice' },
  });
  expect(deps.windowsUserId).toBe('CORP\\alice');
});

test('buildSetupDeps: warns and omits windowsUserId on win32 when env is empty', () => {
  const warnings: string[] = [];
  const deps = buildSetupDeps({
    platform: 'win32',
    programPath: 'C:\\bin\\p.exe',
    serviceUnitPath: 'C:\\tmp\\x.xml',
    serviceManager: sm,
    env: {},
  });
  expect('windowsUserId' in deps).toBe(false);
  expect(warnings).not.toContain('thrown');
});

test('buildSetupOptions: defaults installSource to github_release for unknown values', () => {
  expect(buildSetupOptions({ installSource: 'unknown-source' })).toEqual({
    installSource: 'github_release',
  });
});

test('buildSetupOptions: forwards valid installSource', () => {
  expect(buildSetupOptions({ installSource: 'brew' })).toEqual({ installSource: 'brew' });
  expect(buildSetupOptions({ installSource: 'npm' })).toEqual({ installSource: 'npm' });
});

test('buildSetupOptions: forwards apiKey when set', () => {
  expect(buildSetupOptions({ installSource: 'brew', apiKey: 'k' })).toEqual({
    installSource: 'brew',
    apiKey: 'k',
  });
});

test('buildSetupOptions: noStart=true when start=false', () => {
  expect(buildSetupOptions({ installSource: 'brew', start: false })).toEqual({
    installSource: 'brew',
    noStart: true,
  });
});

test('buildSetupOptions: noStart absent when start=true or undefined', () => {
  expect(buildSetupOptions({ installSource: 'brew', start: true })).toEqual({
    installSource: 'brew',
  });
  expect(buildSetupOptions({ installSource: 'brew' })).toEqual({ installSource: 'brew' });
});

test('buildSetupOptions: forwards force when true', () => {
  expect(buildSetupOptions({ installSource: 'brew', force: true })).toEqual({
    installSource: 'brew',
    force: true,
  });
});

test('invokeSetupInteractive: returns a function that, when invoked, calls the provided runner', async () => {
  let runnerInvoked = false;
  const fn = invokeSetupInteractive(
    {
      platform: 'darwin',
      programPath: '/bin/p',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
    },
    async () => {
      runnerInvoked = true;
      return { exitCode: 0 };
    },
  );
  expect(typeof fn).toBe('function');
  const result = await fn();
  expect(runnerInvoked).toBe(true);
  expect(result.exitCode).toBe(0);
});

test('invokeSetupInteractive: forwards inferred installSource to runSetup options', async () => {
  let capturedInstallSource: unknown = null;
  const fn = invokeSetupInteractive(
    {
      platform: 'darwin',
      programPath: '/Users/x/.bun/install/global/node_modules/@proxai/gateway/dist/main',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
    },
    async (_deps, opts) => {
      capturedInstallSource = opts?.installSource;
      return { exitCode: 0 };
    },
  );
  await fn();
  expect(capturedInstallSource).toBe('bun');
});

test('invokeSetupInteractive: falls back to github_release when no pattern matches programPath', async () => {
  let captured: unknown = null;
  const fn = invokeSetupInteractive(
    {
      platform: 'linux',
      programPath: '/usr/local/bin/proxai-gateway',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
    },
    async (_deps, opts) => {
      captured = opts?.installSource;
      return { exitCode: 0 };
    },
  );
  await fn();
  expect(captured).toBe('github_release');
});
