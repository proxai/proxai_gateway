import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asGlobalFetch } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { rmRecursive } from 'core/io/fs';
import type { ProfileContext, ProfileName } from 'core/io/fs/profile.types.ts';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];

let dir: string;
let devConfigPresent: boolean;

function fakeProfileContext(profile: ProfileName): ProfileContext {
  const configDir = join(dir, profile);
  return {
    name: profile,
    isDev: profile === 'dev',
    configDir,
    configFilePath: join(configDir, 'config.toml'),
    bufferDbPath: join(configDir, 'buffer.db'),
    logDir: join(dir, 'logs', profile),
    sentinels: {
      authFailed: join(configDir, 'AUTH_FAILED'),
      bufferFull: join(configDir, 'BUFFER_FULL'),
      sessionStopped: join(configDir, 'SESSION_STOPPED'),
      consent: join(configDir, 'CONSENT_ACCEPTED'),
      updateAvailable: join(configDir, 'UPDATE_AVAILABLE'),
    },
    controlSocketPath: join(configDir, 'control.sock'),
    defaultNestBaseUrl: profile === 'dev' ? 'http://localhost:3001' : 'https://nest.example',
  };
}

function makeOverrides(): { rootDir: string; devCtx: ProfileContext } {
  return {
    rootDir: dir,
    devCtx: fakeProfileContext('dev'),
  };
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-upgrade-restore-deps-'));
  devConfigPresent = false;
});

afterEach(async () => {
  mock.restore();
  globalThis.fetch = originalFetch;
  await rmRecursive(dir);
}, 30_000);

function writeDevConfig(): void {
  const devCfgPath = fakeProfileContext('dev').configFilePath;
  mkdirSync(join(dir, 'dev'), { recursive: true });
  writeFileSync(devCfgPath, 'token = "x"\n');
  devConfigPresent = true;
}

for (const platform of PLATFORMS) {
  test(`buildCoordinatedUpgradeDeps shape is complete for ${platform}`, async () => {
    const mod = await import('cli/wiring/upgrade-restore-deps.ts');
    const deps = mod.buildCoordinatedUpgradeDeps({
      binaryPath: '/bin/gw',
      platform,
      overrides: makeOverrides(),
    });
    expect(deps.rootDir).toBe(dir);
    expect(deps.devCtx.name).toBe('dev');
    expect(deps.devCtx.isDev).toBe(true);
    expect(typeof deps.devServiceManager.isRunning).toBe('function');
    expect(typeof deps.devConfigExists).toBe('function');
    expect(typeof deps.downloadAndReplaceBinary).toBe('function');
    expect(deps.devConfigExists()).toBe(false);
  });
}

test('buildCoordinatedUpgradeDeps uses a null service manager on an unsupported platform', async () => {
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: '/bin/gw',
    platform: 'freebsd',
    overrides: makeOverrides(),
  });
  expect(await deps.devServiceManager.isRunning()).toBe(false);
  expect(await deps.devServiceManager.isRegistered()).toBe(false);
  expect(await deps.devServiceManager.runtimeInfo()).toEqual({ pid: null, startedAt: null });
  await deps.devServiceManager.ensureRegistered();
  await deps.devServiceManager.start();
  await deps.devServiceManager.stop();
  await deps.devServiceManager.restart();
  await deps.devServiceManager.unregister();
});

test('buildCoordinatedUpgradeDeps devConfigExists reflects the file on disk', async () => {
  writeDevConfig();
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: '/bin/gw',
    platform: 'linux',
    overrides: makeOverrides(),
  });
  expect(devConfigPresent).toBe(true);
  expect(deps.devConfigExists()).toBe(true);
});

for (const platform of PLATFORMS) {
  test(`buildUpgradePostRespawnRestoreDeps shape is complete for ${platform}`, async () => {
    const mod = await import('cli/wiring/upgrade-restore-deps.ts');
    const deps = mod.buildUpgradePostRespawnRestoreDeps({
      platform,
      overrides: makeOverrides(),
    });
    expect(deps.rootDir).toBe(dir);
    expect(deps.devCtx.name).toBe('dev');
    expect(typeof deps.devServiceManager.isRunning).toBe('function');
    expect(deps.devConfigExists()).toBe(false);
  });
}

test('buildRunCoordinatedUpgradeDeps returns undefined in dev mode', async () => {
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const result = mod.buildRunCoordinatedUpgradeDeps({
    binaryPath: '/bin/gw',
    platform: 'linux',
    isDev: true,
    overrides: makeOverrides(),
  });
  expect(result).toBeUndefined();
});

test('buildRunCoordinatedUpgradeDeps returns undefined when dev config is absent', async () => {
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const result = mod.buildRunCoordinatedUpgradeDeps({
    binaryPath: '/bin/gw',
    platform: 'linux',
    isDev: false,
    overrides: makeOverrides(),
  });
  expect(result).toBeUndefined();
});

test('buildRunCoordinatedUpgradeDeps returns deps when dev config exists in prod mode', async () => {
  writeDevConfig();
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const result = mod.buildRunCoordinatedUpgradeDeps({
    binaryPath: '/bin/gw',
    platform: 'linux',
    isDev: false,
    overrides: makeOverrides(),
  });
  expect(result).toBeDefined();
  expect(result?.rootDir).toBe(dir);
});

const ASSET_DOWNLOAD_URL = 'https://example.com/download/asset';

function makeReleaseFetch(tag: string, assetName: string | null, bytes?: Uint8Array): FetchFn {
  return async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      const assets =
        assetName === null ? [] : [{ name: assetName, browser_download_url: ASSET_DOWNLOAD_URL }];
      return new Response(JSON.stringify({ tag_name: tag, assets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(bytes ?? new Uint8Array(0), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
}

test('downloadAndReplaceBinary returns early when version check is not ok', async () => {
  globalThis.fetch = asGlobalFetch(async () => new Response('boom', { status: 500 }));
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: join(dir, 'gw'),
    platform: 'linux',
    overrides: makeOverrides(),
  });
  await deps.downloadAndReplaceBinary();
});

test('downloadAndReplaceBinary returns early when there is no update', async () => {
  globalThis.fetch = asGlobalFetch(
    makeReleaseFetch('v0.0.0', `proxai-gateway-linux-${process.arch}`),
  );
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: join(dir, 'gw'),
    platform: 'linux',
    overrides: makeOverrides(),
  });
  await deps.downloadAndReplaceBinary();
});

test('downloadAndReplaceBinary returns early when no platform asset matches', async () => {
  globalThis.fetch = asGlobalFetch(makeReleaseFetch('v9999.12.31', 'proxai-gateway-other-arch'));
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: join(dir, 'gw'),
    platform: 'linux',
    overrides: makeOverrides(),
  });
  await deps.downloadAndReplaceBinary();
});

test('downloadAndReplaceBinary returns early when download body is empty', async () => {
  globalThis.fetch = asGlobalFetch(
    makeReleaseFetch('v9999.12.31', `proxai-gateway-linux-${process.arch}`, new Uint8Array(0)),
  );
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath: join(dir, 'gw'),
    platform: 'linux',
    overrides: makeOverrides(),
  });
  await deps.downloadAndReplaceBinary();
});

test('downloadAndReplaceBinary replaces the binary on the full success path', async () => {
  const newBytes = new TextEncoder().encode('fresh-binary');
  globalThis.fetch = asGlobalFetch(
    makeReleaseFetch('v9999.12.31', `proxai-gateway-linux-${process.arch}`, newBytes),
  );
  const binaryPath = join(dir, 'gw');
  writeFileSync(binaryPath, 'old');
  const mod = await import('cli/wiring/upgrade-restore-deps.ts');
  const deps = mod.buildCoordinatedUpgradeDeps({
    binaryPath,
    platform: 'linux',
    overrides: makeOverrides(),
  });
  await deps.downloadAndReplaceBinary();
  expect(await Bun.file(binaryPath).text()).toBe('fresh-binary');
});
