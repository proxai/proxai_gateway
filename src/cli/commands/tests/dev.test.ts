import { afterEach, beforeEach, expect, test, mock } from 'bun:test';
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
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
  }
});

afterEach(() => {
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
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
