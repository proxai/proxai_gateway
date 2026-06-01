import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDevDeps,
  buildDevServiceManager,
  buildDevServiceUnitPath,
  verifyKeySimple,
  writeDevConfigFull,
  registerDevHostIdFull,
  __deps,
} from 'cli/wiring/dev-deps.ts';
import { rmRecursive } from 'core/io/fs';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { requireDefined } from 'core/utils';
import type { ServiceManager } from 'cli/service-manager';

const origDeps = { ...__deps };

afterEach(() => {
  Object.assign(__deps, origDeps);
});

// ── buildDevServiceUnitPath ──

test('buildDevServiceUnitPath: darwin returns launchd plist path', () => {
  __deps.defaultLaunchdPlistPath = (label: string) => `/Library/LaunchAgents/${label}.plist`;
  __deps.devLaunchdLabel = () => 'dev-label';
  expect(buildDevServiceUnitPath('darwin', '/tmp/dev')).toBe(
    '/Library/LaunchAgents/dev-label.plist',
  );
});

test('buildDevServiceUnitPath: linux returns systemd unit path', () => {
  __deps.defaultSystemdUnitPath = (name: string) => `/etc/systemd/user/${name}`;
  __deps.devSystemdUnitName = () => 'dev-unit';
  expect(buildDevServiceUnitPath('linux', '/tmp/dev')).toBe('/etc/systemd/user/dev-unit');
});

test('buildDevServiceUnitPath: win32 returns scheduled task xml path', () => {
  __deps.defaultScheduledTaskXmlPath = (dir: string) => `${dir}\\task.xml`;
  expect(buildDevServiceUnitPath('win32', 'C:\\dev')).toBe('C:\\dev\\task.xml');
});

test('buildDevServiceUnitPath: unsupported platform returns null', () => {
  expect(buildDevServiceUnitPath('freebsd' as NodeJS.Platform, '/tmp')).toBeNull();
});

// ── buildDevServiceManager ──

test('buildDevServiceManager: returns null for unsupported platform', () => {
  expect(buildDevServiceManager('freebsd' as NodeJS.Platform, '/tmp')).toBeNull();
});

test('buildDevServiceManager: returns ServiceManager for darwin', () => {
  __deps.defaultLaunchdPlistPath = () => '/tmp/mock.plist';
  __deps.devLaunchdLabel = () => 'mock-label';
  const mockSm = { start: async () => {} } as unknown as ServiceManager;
  __deps.getServiceManager = () => mockSm;
  const result = buildDevServiceManager('darwin', '/tmp/dev');
  expect(result).toBe(mockSm);
});

// ── verifyKeySimple ──

test('verifyKeySimple: creates HttpClient and returns success result', async () => {
  __deps.createHttpClient = () => {
    const stub: unknown = { verifyKey: async () => ({ success: true }) };
    return stub as ReturnType<typeof __deps.createHttpClient>;
  };
  const result = await verifyKeySimple('http://localhost', 'key123');
  expect(result).toEqual({ success: true });
});

test('verifyKeySimple: propagates failure result', async () => {
  __deps.createHttpClient = () => {
    const stub: unknown = { verifyKey: async () => ({ success: false }) };
    return stub as ReturnType<typeof __deps.createHttpClient>;
  };
  const result = await verifyKeySimple('http://localhost', 'bad-key');
  expect(result).toEqual({ success: false });
});

// ── writeDevConfigFull ──

test('writeDevConfigFull: builds config and writes to file', async () => {
  const calls: { config: unknown; path: string }[] = [];
  __deps.readMachineUuid = async () => 'mock-uuid';
  __deps.deriveHostId = (uuid: string, userId: string) => `${uuid}::${userId}`;
  __deps.nowIsoUtc = () => '2026-01-01T00:00:00Z';
  __deps.buildGatewayConfig = (input: Record<string, unknown>) =>
    input as unknown as ReturnType<typeof __deps.buildGatewayConfig>;
  __deps.writeConfigToFile = async (config, path) => {
    calls.push({ config, path });
  };

  const ctx = buildProfileContext('dev');
  await writeDevConfigFull(ctx, 'test-api-key');

  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe(ctx.configFilePath);
  const config = calls[0]?.config as Record<string, unknown>;
  expect(config['apiKey']).toBe('test-api-key');
  expect(config['userId']).toBe('dev');
  expect(config['hostId']).toBe('mock-uuid::dev');
});

// ── registerDevHostIdFull ──

test('registerDevHostIdFull: derives dev host_id and registers via http client', async () => {
  __deps.readMachineUuid = async () => 'machine-xyz';
  __deps.deriveHostId = (uuid: string, userId: string) => `${uuid}::${userId}`;
  const capturedOptions: Parameters<typeof __deps.createHttpClient>[0][] = [];
  __deps.createHttpClient = (options) => {
    capturedOptions.push(options);
    const stub: unknown = { registerHostId: async () => ({ registered: true }) };
    return stub as ReturnType<typeof __deps.createHttpClient>;
  };

  const result = await registerDevHostIdFull('dev-api-key');

  expect(result).toEqual({ registered: true });
  expect(capturedOptions).toHaveLength(1);
  const opts = requireDefined(capturedOptions[0]);
  expect(opts.apiKey).toBe('dev-api-key');
  expect(opts.hostId).toBe('machine-xyz::dev');
  expect(opts.endpoints.registerHostId.endsWith('/v1/host-ids/register')).toBe(true);
});

test('registerDevHostIdFull: surfaces already-bound result', async () => {
  __deps.readMachineUuid = async () => 'machine-xyz';
  __deps.deriveHostId = (uuid: string, userId: string) => `${uuid}::${userId}`;
  __deps.createHttpClient = () => {
    const stub: unknown = { registerHostId: async () => ({ registered: false }) };
    return stub as ReturnType<typeof __deps.createHttpClient>;
  };

  const result = await registerDevHostIdFull('dev-api-key');
  expect(result).toEqual({ registered: false });
});

// ── buildDevDeps (existing test) ──

test('buildDevDeps returns correct dev command dependencies', async () => {
  const deps = buildDevDeps();
  expect(deps.output).toBeDefined();
  expect(typeof deps.devModeSentinelPath).toBe('string');
  expect(deps.devModeSentinelPath).toContain('DEV_MODE');
  expect(deps.devCtx.name).toBe('dev');
  expect(deps.devCtx.isDev).toBe(true);
  expect(typeof deps.devConfigExists).toBe('function');
  expect(typeof (await deps.devConfigExists())).toBe('boolean');
  expect(typeof deps.verifyKey).toBe('function');
  expect(typeof deps.writeDevConfig).toBe('function');
  expect(typeof deps.registerDevHostId).toBe('function');
  expect(typeof deps.clearAuthFailed).toBe('function');
  expect(typeof deps.registerDevServiceUnit).toBe('function');
});

test('buildDevDeps clearAuthFailed targets the dev profile AUTH_FAILED sentinel', async () => {
  const removed: string[] = [];
  __deps.clearAuthFailedSentinel = (path: string) => {
    removed.push(path);
    return Promise.resolve();
  };
  const deps = buildDevDeps();
  await deps.clearAuthFailed();
  expect(removed).toHaveLength(1);
  expect(requireDefined(removed[0])).toBe(buildProfileContext('dev').sentinels.authFailed);
});

// ── registerDevServiceUnit lambda ──

test('registerDevServiceUnit: calls writeServiceUnit and ensureRegistered on darwin', async () => {
  __deps.defaultLaunchdPlistPath = () => '/tmp/mock.plist';
  __deps.devLaunchdLabel = () => 'mock-label';
  let writeInput: Record<string, unknown> | null = null;
  __deps.writeServiceUnit = async (input) => {
    writeInput = input as unknown as Record<string, unknown>;
  };
  let ensured = false;
  __deps.getServiceManager = () =>
    ({
      ensureRegistered: async () => {
        ensured = true;
      },
    }) as unknown as ServiceManager;

  const deps = buildDevDeps();
  await deps.registerDevServiceUnit();

  expect(writeInput).not.toBeNull();
  expect((writeInput as unknown as Record<string, unknown>)['profileName']).toBe('dev');
  expect(ensured).toBe(true);
});

// ── __deps real wrapper bodies (no stubbing) ──

test('__deps wrappers invoke the real underlying implementations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxai-devdeps-'));
  try {
    const http = __deps.createHttpClient({
      apiKey: 'real-key',
      hostId: 'real-host',
      endpoints: {
        ingest: 'https://nest.example.com/ingest',
        verifyKey: 'https://nest.example.com/verify',
        watermarks: 'https://nest.example.com/watermarks',
        registerHostId: 'https://nest.example.com/register',
      },
      gatewayVersion: '@proxai/gateway 0.0.0',
    });
    expect(http).toBeDefined();
    expect(typeof http.verifyKey).toBe('function');

    const machineUuid = await __deps.readMachineUuid();
    expect(typeof machineUuid).toBe('string');
    expect(machineUuid.length).toBeGreaterThan(0);

    const hostId = __deps.deriveHostId(machineUuid, 'dev');
    expect(typeof hostId).toBe('string');
    expect(hostId.length).toBeGreaterThan(0);

    const stamp = __deps.nowIsoUtc();
    expect(typeof stamp).toBe('string');
    expect(stamp.endsWith('Z')).toBe(true);

    const config = __deps.buildGatewayConfig({
      apiKey: 'real-key',
      userId: 'dev',
      hostId,
      installedAt: stamp,
      installSource: 'github_release',
      bufferDbPath: join(dir, 'buffer.db'),
      logDir: join(dir, 'logs'),
      defaultNestBaseUrl: 'https://nest.example.com',
    });
    expect(config.account.apiKey).toBe('real-key');
    expect(config.account.userId).toBe('dev');
    expect(config.account.hostId).toBe(hostId);
    expect(config.capture.bufferPath).toBe(join(dir, 'buffer.db'));

    const configPath = join(dir, 'config.toml');
    await __deps.writeConfigToFile(config, configPath);
    expect(existsSync(configPath)).toBe(true);

    await __deps.clearAuthFailedSentinel(join(dir, 'AUTH_FAILED'));
    expect(existsSync(join(dir, 'AUTH_FAILED'))).toBe(false);

    const unitPath = join(dir, 'unit-out');
    await __deps.writeServiceUnit({
      serviceUnitPath: unitPath,
      programPath: process.execPath,
      platform: process.platform,
      profileName: 'dev',
    });
    expect(existsSync(unitPath)).toBe(true);

    const launchdPath = __deps.defaultLaunchdPlistPath('com.proxai.gateway.dev');
    expect(typeof launchdPath).toBe('string');
    expect(launchdPath.length).toBeGreaterThan(0);

    const systemdPath = __deps.defaultSystemdUnitPath('proxai-gateway-dev.service');
    expect(typeof systemdPath).toBe('string');
    expect(systemdPath.length).toBeGreaterThan(0);

    const taskPath = __deps.defaultScheduledTaskXmlPath(dir);
    expect(typeof taskPath).toBe('string');
    expect(taskPath.length).toBeGreaterThan(0);

    expect(typeof __deps.devLaunchdLabel()).toBe('string');
    expect(__deps.devLaunchdLabel().length).toBeGreaterThan(0);
    expect(typeof __deps.devSystemdUnitName()).toBe('string');
    expect(__deps.devSystemdUnitName().length).toBeGreaterThan(0);
  } finally {
    await rmRecursive(dir);
  }
}, 30_000);
