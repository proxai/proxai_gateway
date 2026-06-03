import { afterEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceManager } from 'cli/service-manager';
import { devLaunchdLabel, devSystemdUnitName } from 'cli/service-unit/dev-labels.ts';
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from 'cli/cli.constants.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { rmRecursive } from 'core/io/fs';
import { openBufferDb } from 'services/buffer';
import { writeConfigToFile, type GatewayConfig } from 'services/config';
import {
  buildSetupDeps,
  buildSetupOptions,
  invokeSetupInteractive,
  resolveSetupServiceContext,
} from 'cli/wiring/setup-deps.ts';

const profileCtx = buildProfileContext('prod');
const devProfileCtx = buildProfileContext('dev');

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

const PROFILE_ROOT_ENV = 'PROXAI_TEST_PROFILE_ROOT';

afterEach(() => {
  delete process.env[PROFILE_ROOT_ENV];
});

function configWithPaths(bufferPath: string, logDir: string): GatewayConfig {
  return {
    account: {
      apiKey: 'pxg_live_secret',
      userId: 'u_1',
      hostId: '01HZ-test-host',
      installedAt: '2026-04-28T22:30:00Z',
      installSource: 'bun',
    },
    backend: {
      ingestUrl: 'https://nest.proxai.co/v1/raw_records',
      verifyKeyUrl: 'https://nest.proxai.co/ingestion/verify-key',
      watermarksUrl: 'https://nest.proxai.co/v1/watermarks',
      registerHostIdUrl: 'https://nest.proxai.co/v1/host-ids/register',
    },
    capture: {
      pollIntervalSec: 300,
      bufferPath,
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      bufferSoftPauseBytes: 700 * 1024 * 1024,
      bufferSoftResumeBytes: 600 * 1024 * 1024,
      uploadMaxBatchesPerSec: 5,
      uploadMaxBytesPerMinute: 50 * 1024 * 1024,
      uploadBackoffOn429Multiplier: 2,
    },
    logging: {
      level: 'info',
      logDir,
    },
    staleBinary: {
      warnAfterDays: 90,
      pauseAfterDays: 180,
    },
  };
}

test('resolveSetupServiceContext: dev profile resolves the dev launchd unit on darwin', () => {
  const ctx = resolveSetupServiceContext('darwin', '/bin/p', devProfileCtx);
  expect(ctx.serviceUnitPath).not.toBeNull();
  expect(ctx.serviceUnitPath).toContain(`${devLaunchdLabel()}.plist`);
  expect(ctx.serviceUnitPath).not.toContain(`${LAUNCHD_LABEL}.plist`);
  expect(ctx.serviceManager).not.toBeNull();
});

test('resolveSetupServiceContext: dev profile resolves the dev systemd unit on linux', () => {
  const ctx = resolveSetupServiceContext('linux', '/bin/p', devProfileCtx);
  expect(ctx.serviceUnitPath).not.toBeNull();
  expect(ctx.serviceUnitPath).toContain(devSystemdUnitName());
  expect(ctx.serviceUnitPath).not.toContain(`/${SYSTEMD_UNIT_NAME}`);
  expect(ctx.serviceManager).not.toBeNull();
});

test('resolveSetupServiceContext: dev profile resolves the dev scheduled task under the dev config dir on win32', () => {
  const ctx = resolveSetupServiceContext('win32', 'C:\\bin\\p.exe', devProfileCtx);
  expect(ctx.serviceUnitPath).not.toBeNull();
  expect(ctx.serviceUnitPath).toContain(devProfileCtx.configDir);
  expect(ctx.serviceManager).not.toBeNull();
});

test('resolveSetupServiceContext: dev profile returns nulls on an unsupported platform', () => {
  const ctx = resolveSetupServiceContext('freebsd' as NodeJS.Platform, '/bin/p', devProfileCtx);
  expect(ctx.serviceUnitPath).toBeNull();
  expect(ctx.serviceManager).toBeNull();
});

test('resolveSetupServiceContext: prod profile resolves the prod launchd unit on darwin', () => {
  const ctx = resolveSetupServiceContext('darwin', '/bin/p', profileCtx);
  expect(ctx.serviceUnitPath).not.toBeNull();
  expect(ctx.serviceUnitPath).toContain(`${LAUNCHD_LABEL}.plist`);
  expect(ctx.serviceUnitPath).not.toContain(`${devLaunchdLabel()}.plist`);
  expect(ctx.serviceManager).not.toBeNull();
});

test('resolveSetupServiceContext: prod profile returns nulls on an unsupported platform', () => {
  const ctx = resolveSetupServiceContext('freebsd' as NodeJS.Platform, '/bin/p', profileCtx);
  expect(ctx.serviceUnitPath).toBeNull();
  expect(ctx.serviceManager).toBeNull();
});

test('buildSetupDeps: omits serviceManager when null and platform=darwin', async () => {
  const deps = await buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
    profileCtx,
  });
  expect(deps.platform).toBe('darwin');
  expect(deps.serviceUnitPath).toBe(null);
  expect('serviceManager' in deps).toBe(false);
  expect('windowsUserId' in deps).toBe(false);
});

test('buildSetupDeps: includes serviceManager when provided', async () => {
  const deps = await buildSetupDeps({
    platform: 'linux',
    programPath: '/bin/p',
    serviceUnitPath: '/tmp/x.service',
    serviceManager: sm,
    env: {},
    profileCtx,
  });
  expect(deps.serviceManager).toBe(sm);
  expect(deps.serviceUnitPath).toBe('/tmp/x.service');
});

test('buildSetupDeps: configExists() resolves with a boolean', async () => {
  const deps = await buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
    profileCtx,
  });
  await expect(deps.configExists()).resolves.toEqual(expect.any(Boolean));
});

test('buildSetupDeps: readLastSuccessAt handles absent, empty, and unreadable buffers', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'proxai-setup-deps-'));
  try {
    const bufferDbPath = join(tmp, 'buffer.db');
    const configFilePath = join(tmp, 'config.toml');
    const deps = await buildSetupDeps({
      platform: 'linux',
      programPath: '/bin/p',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
      profileCtx: { ...profileCtx, bufferDbPath, configFilePath },
    });
    const read = deps.readLastSuccessAt;
    if (read === undefined) throw new Error('readLastSuccessAt not wired');
    expect(await read()).toBeNull();
    openBufferDb(bufferDbPath).close();
    expect(await read()).toBeNull();
    await Bun.write(bufferDbPath, 'not a sqlite database at all — just garbage bytes');
    expect(await read()).toBeNull();
  } finally {
    await rmRecursive(tmp);
  }
});

test('buildSetupDeps: follows config.toml capture.buffer_path and logging.log_dir, falling back to profileCtx defaults when absent', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'proxai-setup-deps-config-'));
  try {
    process.env[PROFILE_ROOT_ENV] = tmp;
    const ctx = buildProfileContext('prod');

    const fallback = await buildSetupDeps({
      platform: 'linux',
      programPath: '/bin/p',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
      profileCtx: ctx,
    });
    expect(fallback.bufferDbPath).toBe(ctx.bufferDbPath);
    expect(fallback.logDir).toBe(ctx.logDir);

    const customBufferPath = join(tmp, 'custom', 'buffer.db');
    const customLogDir = join(tmp, 'custom', 'logs');
    expect(customBufferPath).not.toBe(ctx.bufferDbPath);
    await writeConfigToFile(configWithPaths(customBufferPath, customLogDir), ctx.configFilePath);

    const followed = await buildSetupDeps({
      platform: 'linux',
      programPath: '/bin/p',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
      profileCtx: ctx,
    });
    expect(followed.bufferDbPath).toBe(customBufferPath);
    expect(followed.logDir).toBe(customLogDir);
  } finally {
    await rmRecursive(tmp);
  }
});

test('buildSetupDeps: httpClientFactory returns a working HttpClient', async () => {
  const deps = await buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
    profileCtx,
  });
  const client = deps.httpClientFactory('test-key', 'test-host');
  expect(client).toBeDefined();
});

test('buildSetupDeps: readMachineUuid is wired and returns a string or throws GatewayError', async () => {
  const deps = await buildSetupDeps({
    platform: 'darwin',
    programPath: '/bin/p',
    serviceUnitPath: null,
    serviceManager: null,
    env: {},
    profileCtx,
  });
  expect(deps.readMachineUuid).toBeDefined();
  const reader = deps.readMachineUuid;
  if (reader === undefined) throw new Error('readMachineUuid not wired');
  try {
    const uuid = await reader();
    expect(typeof uuid).toBe('string');
    expect(uuid.length).toBeGreaterThan(0);
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('machine UUID');
  }
});

test('buildSetupDeps: sets windowsUserId on win32 when env supports it', async () => {
  const deps = await buildSetupDeps({
    platform: 'win32',
    programPath: 'C:\\bin\\p.exe',
    serviceUnitPath: 'C:\\tmp\\x.xml',
    serviceManager: sm,
    env: { USERDOMAIN: 'CORP', USERNAME: 'alice' },
    profileCtx,
  });
  expect(deps.windowsUserId).toBe('CORP\\alice');
});

test('buildSetupDeps: warns and omits windowsUserId on win32 when env is empty', async () => {
  const warnings: string[] = [];
  const deps = await buildSetupDeps({
    platform: 'win32',
    programPath: 'C:\\bin\\p.exe',
    serviceUnitPath: 'C:\\tmp\\x.xml',
    serviceManager: sm,
    env: {},
    profileCtx,
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

test('invokeSetupInteractive: returns a function that, when invoked, calls the provided runner', async () => {
  let runnerInvoked = false;
  const fn = invokeSetupInteractive(
    {
      platform: 'darwin',
      programPath: '/bin/p',
      serviceUnitPath: null,
      serviceManager: null,
      env: {},
      profileCtx,
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
      profileCtx,
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
      profileCtx,
    },
    async (_deps, opts) => {
      captured = opts?.installSource;
      return { exitCode: 0 };
    },
  );
  await fn();
  expect(captured).toBe('github_release');
});
