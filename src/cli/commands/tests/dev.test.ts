import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Logger, LoggerFactoryOptions } from 'core/log';
import type { CommandResult } from 'cli/cli.types.ts';
import { DEV_NEST_URL, runDev } from 'cli/commands/dev.ts';
import type { RunCommandDeps } from 'cli/commands/run';
import { captureOutput } from 'cli/output.ts';
import type { GatewayConfig } from 'services/config';

function makeConfig(): GatewayConfig {
  return {
    account: {
      apiKey: 'k',
      userId: 'u',
      hostId: 'h',
      installedAt: '2026-01-01T00:00:00Z',
      installSource: 'github_release',
    },
    backend: {
      ingestUrl: 'https://prod.example/v1/raw_records',
      verifyKeyUrl: 'https://prod.example/ingestion/verify-key',
      watermarksUrl: 'https://prod.example/v1/watermarks',
      registerHostIdUrl: 'https://prod.example/v1/host-ids/register',
    },
    capture: {
      pollIntervalSec: 60,
      bufferPath: '/tmp/buffer.db',
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      bufferSoftPauseBytes: 100,
      bufferSoftResumeBytes: 50,
      initialScanWindowDays: 30,
      uploadMaxBatchesPerSec: 5,
      uploadMaxBytesPerMinute: 50,
      uploadBackoffOn429Multiplier: 2,
    },
    logging: { level: 'info', logDir: '/tmp/logs' },
    staleBinary: { warnAfterDays: 30, pauseAfterDays: 60 },
  };
}

const noop = (): void => undefined;

function fakeLogger(): Logger {
  const log = {
    child: () => log,
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
  };
  return log as unknown as Logger;
}

const PRIOR_ENV = process.env['PROXAI_GATEWAY_NEST_ENDPOINT'];

beforeEach(() => {
  delete process.env['PROXAI_GATEWAY_NEST_ENDPOINT'];
});

afterEach(() => {
  if (PRIOR_ENV !== undefined) {
    process.env['PROXAI_GATEWAY_NEST_ENDPOINT'] = PRIOR_ENV;
  } else {
    delete process.env['PROXAI_GATEWAY_NEST_ENDPOINT'];
  }
});

test('runDev forces PROXAI_GATEWAY_NEST_ENDPOINT to localhost:3001 even when previously set to a prod url', async () => {
  process.env['PROXAI_GATEWAY_NEST_ENDPOINT'] = 'https://production.example.com';
  let captured: RunCommandDeps | null = null;
  const cfg = makeConfig();
  const out = captureOutput();
  const result = await runDev({
    output: out,
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    loadConfig: async () => cfg,
    runDaemon: async (d: RunCommandDeps): Promise<CommandResult> => {
      captured = d;
      return { exitCode: 0 };
    },
    createLogger: async (_options: LoggerFactoryOptions) => fakeLogger(),
  });
  expect(result.exitCode).toBe(0);
  expect(process.env['PROXAI_GATEWAY_NEST_ENDPOINT']).toBe(DEV_NEST_URL);
  expect(captured).not.toBeNull();
  const c = captured as unknown as RunCommandDeps;
  expect(c.devMode).toBe(true);
  expect(c.config.backend.ingestUrl).toBe(`${DEV_NEST_URL}/v1/raw_records`);
  expect(c.config.backend.verifyKeyUrl).toBe(`${DEV_NEST_URL}/ingestion/verify-key`);
  expect(c.config.backend.watermarksUrl).toBe(`${DEV_NEST_URL}/v1/watermarks`);
  expect(c.config.backend.registerHostIdUrl).toBe(`${DEV_NEST_URL}/v1/host-ids/register`);
  expect(c.installSource).toBe('github_release');
  expect(c.gatewayVersion).toBe('gw');
  expect(c.currentVersion).toBe('2026.5.7');
  expect(c.binaryPath).toBe('/tmp/bin');
  expect(c.logger).toBeDefined();
});

test('runDev forces nest url even when env var was unset', async () => {
  let captured: RunCommandDeps | null = null;
  const cfg = makeConfig();
  await runDev({
    output: captureOutput(),
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    loadConfig: async () => cfg,
    runDaemon: async (d: RunCommandDeps): Promise<CommandResult> => {
      captured = d;
      return { exitCode: 0 };
    },
    createLogger: async () => fakeLogger(),
  });
  expect(process.env['PROXAI_GATEWAY_NEST_ENDPOINT']).toBe(DEV_NEST_URL);
  expect(captured).not.toBeNull();
});

test('runDev passes updateAvailableSentinelPath through when provided', async () => {
  let captured: RunCommandDeps | null = null;
  await runDev({
    output: captureOutput(),
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    updateAvailableSentinelPath: '/tmp/UPDATE',
    loadConfig: async () => makeConfig(),
    runDaemon: async (d: RunCommandDeps): Promise<CommandResult> => {
      captured = d;
      return { exitCode: 0 };
    },
    createLogger: async () => fakeLogger(),
  });
  expect((captured as unknown as RunCommandDeps).updateAvailableSentinelPath).toBe('/tmp/UPDATE');
});

test('runDev returns the runDaemon exit code on non-zero', async () => {
  const result = await runDev({
    output: captureOutput(),
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    loadConfig: async () => makeConfig(),
    runDaemon: async () => ({ exitCode: 1 }),
    createLogger: async () => fakeLogger(),
  });
  expect(result.exitCode).toBe(1);
});

test('runDev passes pretty=true to createLogger', async () => {
  let receivedOpts: LoggerFactoryOptions | null = null;
  await runDev({
    output: captureOutput(),
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    loadConfig: async () => makeConfig(),
    runDaemon: async () => ({ exitCode: 0 }),
    createLogger: async (options) => {
      receivedOpts = options;
      return fakeLogger();
    },
  });
  expect(receivedOpts).not.toBeNull();
  expect((receivedOpts as unknown as LoggerFactoryOptions).pretty).toBe(true);
  expect((receivedOpts as unknown as LoggerFactoryOptions).level).toBe('info');
});

test('runDev applies env override to provided env object instead of process.env when given', async () => {
  const env: NodeJS.ProcessEnv = {};
  await runDev({
    output: captureOutput(),
    abortSignal: new AbortController().signal,
    gatewayVersion: 'gw',
    currentVersion: '2026.5.7',
    binaryPath: '/tmp/bin',
    pauseSentinelPath: '/tmp/PAUSED',
    authFailedSentinelPath: '/tmp/AUTH_FAILED',
    bufferFullSentinelPath: '/tmp/BUFFER_FULL',
    sessionStoppedSentinelPath: '/tmp/SESSION_STOPPED',
    loadConfig: async () => makeConfig(),
    runDaemon: async () => ({ exitCode: 0 }),
    createLogger: async () => fakeLogger(),
    env,
  });
  expect(env['PROXAI_GATEWAY_NEST_ENDPOINT']).toBe(DEV_NEST_URL);
});
