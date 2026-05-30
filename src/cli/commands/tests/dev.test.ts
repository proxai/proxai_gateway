import { afterAll, afterEach, beforeEach, expect, test, mock } from 'bun:test';
import * as bootIdReal from 'core/system/boot-id.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { runDev } from 'cli/commands/dev.ts';
import { captureOutput } from 'cli/output.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { DevCommandDeps } from 'cli/commands/dev.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

mock.module('core/system/boot-id.ts', () => ({
  readBootId: () => Promise.resolve('mock-boot-id-dev-cmd'),
}));

const mockSentinelPath = join(tmpdir(), `DEV_MODE_CMD_TEST_${Math.random().toString(36).slice(2)}`);

const mockDevCtx: ProfileContext = {
  name: 'dev',
  isDev: true,
  configDir: join(tmpdir(), 'proxai-dev-test'),
  configFilePath: join(tmpdir(), 'proxai-dev-test', 'config.toml'),
  bufferDbPath: join(tmpdir(), 'proxai-dev-test', 'buffer.db'),
  logDir: join(tmpdir(), 'proxai-dev-test', 'logs'),
  sentinels: {
    authFailed: join(tmpdir(), 'proxai-dev-test', 'AUTH_FAILED'),
    bufferFull: join(tmpdir(), 'proxai-dev-test', 'BUFFER_FULL'),
    sessionStopped: join(tmpdir(), 'proxai-dev-test', 'SESSION_STOPPED'),
    consent: join(tmpdir(), 'proxai-dev-test', 'CONSENT_ACCEPTED'),
    updateAvailable: join(tmpdir(), 'proxai-dev-test', 'UPDATE_AVAILABLE'),
  },
  controlSocketPath: join(tmpdir(), 'proxai-dev-test', 'control.sock'),
  defaultNestBaseUrl: 'http://localhost:3001',
};

function makeDevDeps(overrides: Partial<DevCommandDeps> = {}): DevCommandDeps {
  return {
    output: captureOutput(),
    devModeSentinelPath: mockSentinelPath,
    devCtx: mockDevCtx,
    devConfigExists: () => Promise.resolve(false),
    devServiceManager: null,
    verifyKey: () => Promise.resolve({ success: true }),
    writeDevConfig: () => Promise.resolve(),
    registerDevServiceUnit: () => Promise.resolve(),
    ...overrides,
  };
}

beforeEach(() => {
  try {
    unlinkSync(mockSentinelPath);
  } catch {
    // Sentinel may not exist yet
  }
});

afterEach(() => {
  try {
    unlinkSync(mockSentinelPath);
  } catch {
    // Sentinel may not exist
  }
});

test('runDev action="on" enables dev mode', async () => {
  const deps = makeDevDeps();
  const result = await runDev(deps, 'on');

  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(true);
  const successMsgs = (deps.output as ReturnType<typeof captureOutput>).lines
    .filter((l) => l.level === 'success')
    .map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode on');
});

test('runDev action="off" disables dev mode', async () => {
  const deps = makeDevDeps();
  await runDev(deps, 'on');
  expect(existsSync(mockSentinelPath)).toBe(true);

  (deps.output as ReturnType<typeof captureOutput>).lines.length = 0;
  const result = await runDev(deps, 'off');

  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(false);
  const successMsgs = (deps.output as ReturnType<typeof captureOutput>).lines
    .filter((l) => l.level === 'success')
    .map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode off');
});

test('runDev toggles dev mode (action undefined)', async () => {
  const deps = makeDevDeps();

  let result = await runDev(deps);
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(true);
  let successMsgs = (deps.output as ReturnType<typeof captureOutput>).lines
    .filter((l) => l.level === 'success')
    .map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode on');

  (deps.output as ReturnType<typeof captureOutput>).lines.length = 0;
  result = await runDev(deps);
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(false);
  successMsgs = (deps.output as ReturnType<typeof captureOutput>).lines
    .filter((l) => l.level === 'success')
    .map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode off');
});

test('runDev returns error for invalid action', async () => {
  const deps = makeDevDeps();
  const result = await runDev(deps, 'invalid');

  expect(result.exitCode).toBe(EXIT_CODE.error);
  expect(existsSync(mockSentinelPath)).toBe(false);
  const errorMsgs = (deps.output as ReturnType<typeof captureOutput>).lines
    .filter((l) => l.level === 'error')
    .map((l) => l.msg);
  expect(errorMsgs.join(' ')).toContain("Invalid action: 'invalid'");
});

test('runDevOn: starts dev daemon if devConfigExists and not running', async () => {
  let started = false;
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {
      started = true;
    },
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devConfigExists: () => Promise.resolve(true),
    devServiceManager: sm,
  });

  const result = await runDev(deps, 'on');
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(started).toBe(true);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('Dev mode on. Dev daemon started.'),
    ),
  ).toBe(true);
});

test('runDevOn: ignores start failure in try-catch', async () => {
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {
      throw new Error('fail');
    },
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devConfigExists: () => Promise.resolve(true),
    devServiceManager: sm,
  });

  const result = await runDev(deps, 'on');
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('Dev mode on.'),
    ),
  ).toBe(true);
});

test('runDevOn: outputs dev mode on when config exists but already running', async () => {
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => true,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devConfigExists: () => Promise.resolve(true),
    devServiceManager: sm,
  });

  const result = await runDev(deps, 'on');
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('Dev mode on.'),
    ),
  ).toBe(true);
});

test('runDevSetup: returns validation error if key missing', async () => {
  const deps = makeDevDeps();
  const result = await runDev(deps, 'setup');
  expect(result.exitCode).toBe(EXIT_CODE.validationError);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('usage: proxai-gateway dev setup <KEY>'),
    ),
  ).toBe(true);
});

test('runDevSetup: verification failure returns auth error', async () => {
  const deps = makeDevDeps({
    verifyKey: () => Promise.resolve({ success: false }),
  });
  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.authError);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('dev ingestion key not accepted'),
    ),
  ).toBe(true);
});

test('runDevSetup: verifyKey throwing returns auth error', async () => {
  const deps = makeDevDeps({
    verifyKey: () => Promise.reject(new Error('connection timeout')),
  });
  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.authError);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('key verification failed: connection timeout'),
    ),
  ).toBe(true);
});

test('runDevSetup: verifyKey throwing non-Error returns auth error', async () => {
  const deps = makeDevDeps({
    verifyKey: () => Promise.reject('string-timeout'),
  });
  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.authError);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('key verification failed: string-timeout'),
    ),
  ).toBe(true);
});

test('runDevSetup: writeDevConfig throwing returns error', async () => {
  const deps = makeDevDeps({
    writeDevConfig: () => Promise.reject(new Error('disk full')),
  });
  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.error);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('failed to write dev config: disk full'),
    ),
  ).toBe(true);
});

test('runDevSetup: writeDevConfig throwing non-Error returns error', async () => {
  const deps = makeDevDeps({
    writeDevConfig: () => Promise.reject('string-disk-full'),
  });
  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.error);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('failed to write dev config: string-disk-full'),
    ),
  ).toBe(true);
});

test('runDevSetup: successfully sets up and starts dev daemon', async () => {
  let registered = false;
  let started = false;
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {
      started = true;
    },
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devServiceManager: sm,
    registerDevServiceUnit: async () => {
      registered = true;
    },
  });

  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(registered).toBe(true);
  expect(started).toBe(true);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('Dev setup complete. Dev daemon started.'),
    ),
  ).toBe(true);
});

test('runDevSetup: service unit registration failure is warned but setup succeeds', async () => {
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devServiceManager: sm,
    registerDevServiceUnit: async () => {
      throw new Error('registry error');
    },
  });

  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('dev service unit registration failed: registry error'),
    ),
  ).toBe(true);
});

test('runDevSetup: service unit registration non-Error failure is warned but setup succeeds', async () => {
  const sm = {
    ensureRegistered: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const deps = makeDevDeps({
    devServiceManager: sm,
    registerDevServiceUnit: async () => {
      throw 'string-registry-error';
    },
  });

  const result = await runDev(deps, 'setup', { apiKey: 'key123' });
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(
    (deps.output as ReturnType<typeof captureOutput>).lines.some((l) =>
      l.msg.includes('dev service unit registration failed: string-registry-error'),
    ),
  ).toBe(true);
});

afterAll(() => {
  mock.module('core/system/boot-id.ts', () => bootIdReal);
});
