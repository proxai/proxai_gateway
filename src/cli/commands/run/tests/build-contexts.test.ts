import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Logger } from 'core/log';
import type { HttpClient } from 'services/http';
import type { Pacer } from 'services/uploader';
import type { RegisteredSource } from 'services/polling';
import type { RunCommandDeps } from 'cli/commands/run/run.types.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { requireDefined } from 'core/utils';

import {
  buildCaptureContext,
  buildDaemonContexts,
  buildDrainContext,
  buildHeartbeatContext,
  buildLoopOptions,
} from 'cli/commands/run/build-contexts.ts';

function makeMockDeps(overrides: Partial<RunCommandDeps> = {}): RunCommandDeps {
  const deps = {
    output: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {
      account: {
        hostId: 'mock-host-id',
        apiKey: 'key',
        installedAt: '2026-05-01',
        installSource: 'brew' as const,
      },
      capture: {
        pollIntervalSec: 60,
        bufferPath: '/tmp/buffer.db',
        receiptRetentionDays: 7,
        failedRetentionDays: 30,
        bufferSoftPauseBytes: 1000,
        bufferSoftResumeBytes: 500,
        uploadMaxBatchesPerSec: 10,
        uploadMaxBytesPerMinute: 10000,
        uploadBackoffOn429Multiplier: 2,
        maxDecompressedBytes: 2000,
      },
      staleBinary: {
        warnAfterDays: 30,
        pauseAfterDays: 90,
      },
      uploader: {
        concurrentConnections: 2,
        maxAttempts: 5,
        maxRetries: 3,
        backoffMultiplier: 2,
        initialIntervalMs: 1000,
      },
      sources: {},
    },
    authFailedSentinelPath: '/tmp/auth-failed',
    bufferFullSentinelPath: '/tmp/buffer-full',
    sessionStoppedSentinelPath: '/tmp/session-stopped',
    abortSignal: new AbortController().signal,
    gatewayVersion: '1.0.0',
    profileCtx: buildProfileContext('dev'),
  } as unknown as RunCommandDeps;

  // We only assign non-undefined overrides to respect exactOptionalPropertyTypes
  for (const key of Object.keys(overrides) as Array<keyof RunCommandDeps>) {
    if (overrides[key] !== undefined) {
      (deps as unknown as Record<string, unknown>)[key] = overrides[key];
    } else {
      delete deps[key];
    }
  }
  return deps;
}

const mockDb = {} as unknown as Database;
const mockLogger = {} as unknown as Logger;
const mockHttp = {} as unknown as HttpClient;
const mockPacer = {} as unknown as Pacer;
const mockSources = [] as unknown as readonly RegisteredSource[];

test('buildCaptureContext: correctly maps capture context fields', () => {
  const deps = makeMockDeps();
  const ctx = buildCaptureContext({
    buffer: mockDb,
    deps,
    sources: mockSources,
    logger: mockLogger,
  });

  expect(ctx.buffer).toBe(mockDb);
  expect(ctx.gatewayVersion).toBe(deps.gatewayVersion);
  expect(ctx.sources).toBe(mockSources);
  expect(ctx.authFailedSentinelPath).toBe(deps.authFailedSentinelPath);
  expect(ctx.bufferFullSentinelPath).toBe(deps.bufferFullSentinelPath);
  expect(ctx.bufferPolicy.receiptRetentionDays).toBe(deps.config.capture.receiptRetentionDays);
  expect(ctx.capturePolicy.maxDecompressedBytes).toBe(2000);
  expect(ctx.logger).toBe(mockLogger);
  expect(ctx.loadDesktopCliSessionIds).toBeUndefined();
});

test('buildCaptureContext: forwards loadDesktopCliSessionIds when present on deps', () => {
  const loader = async (): Promise<ReadonlySet<string>> => new Set(['sess']);
  const deps = makeMockDeps({ loadDesktopCliSessionIds: loader });
  const ctx = buildCaptureContext({
    buffer: mockDb,
    deps,
    sources: mockSources,
    logger: mockLogger,
  });
  expect(ctx.loadDesktopCliSessionIds).toBe(loader);
});

test('buildDrainContext: correctly maps drain context fields', () => {
  const deps = makeMockDeps();
  const ctx = buildDrainContext({
    buffer: mockDb,
    deps,
    http: mockHttp,
    pacer: mockPacer,
    logger: mockLogger,
  });

  expect(ctx.buffer).toBe(mockDb);
  expect(ctx.http).toBe(mockHttp);
  expect(ctx.hostId).toBe(deps.config.account.hostId);
  expect(ctx.authFailedSentinelPath).toBe(deps.authFailedSentinelPath);
  expect(ctx.bufferFullSentinelPath).toBe(deps.bufferFullSentinelPath);
  expect(ctx.bufferPolicy.receiptRetentionDays).toBe(deps.config.capture.receiptRetentionDays);
  expect(ctx.pacer).toBe(mockPacer);
  expect(ctx.logger).toBe(mockLogger);
});

test('buildHeartbeatContext: correctly maps all optional and required fields', () => {
  const deps = makeMockDeps({
    updateAvailableSentinelPath: '/tmp/update-available',
    currentVersion: '2026.5.28',
    binaryPath: '/bin/proxai',
    devMode: false,
    exitProcess: () => {},
    coordinatedUpgradeDeps: {
      rootDir: '/tmp',
      devCtx: {
        name: 'dev',
        isDev: true,
        configDir: '/tmp',
        configFilePath: '/tmp/config.toml',
        bufferDbPath: '/tmp/buffer.db',
        logDir: '/tmp/logs',
        sentinels: {
          authFailed: '/tmp/auth',
          bufferFull: '/tmp/full',
          sessionStopped: '/tmp/stop',
          consent: '/tmp/consent',
          updateAvailable: '/tmp/update',
          rescueLedger: '/tmp/rescue-ledger.json',
        },
        controlSocketPath: '/tmp/sock',
        defaultNestBaseUrl: 'http://localhost',
      },
      devServiceManager: {
        ensureRegistered: async () => {},
        start: async () => {},
        stop: async () => {},
        restart: async () => {},
        unregister: async () => {},
        isRegistered: async () => true,
        isRunning: async () => false,
        runtimeInfo: async () => ({ pid: null, startedAt: null }),
      },
      devConfigExists: () => true,
      downloadAndReplaceBinary: async () => {},
    },
    installSource: 'brew',
  });
  const ctx = buildHeartbeatContext({
    buffer: mockDb,
    deps,
    logger: mockLogger,
  });

  expect(ctx.buffer).toBe(mockDb);
  expect(ctx.gatewayVersion).toBe(deps.gatewayVersion);
  expect(ctx.installedAt).toBe(deps.config.account.installedAt);
  expect(ctx.staleBinary.warnAfterDays).toBe(deps.config.staleBinary.warnAfterDays);
  expect(ctx.staleBinary.pauseAfterDays).toBe(deps.config.staleBinary.pauseAfterDays);
  expect(ctx.installSource).toBe('brew');
  expect(ctx.logger).toBe(mockLogger);
  expect(ctx.updateAvailableSentinelPath).toBe(deps.updateAvailableSentinelPath);
  expect(ctx.currentVersion).toBe(deps.currentVersion);
  expect(ctx.binaryPath).toBe(deps.binaryPath);
  expect(ctx.devMode).toBe(deps.devMode);
  expect(ctx.exitProcess).toBe(deps.exitProcess);
  expect(ctx.coordinatedUpgradeDeps).toBe(deps.coordinatedUpgradeDeps);
});

test('buildHeartbeatContext: respects fallback / missing optional fields', () => {
  const deps = makeMockDeps();
  // Ensure optional properties are not set on deps to trigger fallback / checks
  delete (deps as Partial<RunCommandDeps>).updateAvailableSentinelPath;
  delete (deps as Partial<RunCommandDeps>).currentVersion;
  delete (deps as Partial<RunCommandDeps>).binaryPath;
  delete (deps as Partial<RunCommandDeps>).devMode;
  delete (deps as Partial<RunCommandDeps>).exitProcess;
  delete (deps as Partial<RunCommandDeps>).coordinatedUpgradeDeps;
  delete (deps as Partial<RunCommandDeps>).installSource;

  const ctx = buildHeartbeatContext({
    buffer: mockDb,
    deps,
    logger: mockLogger,
  });

  expect(ctx.installSource).toBe(deps.config.account.installSource);
  expect(ctx.updateAvailableSentinelPath).toBeUndefined();
  expect(ctx.currentVersion).toBeUndefined();
  expect(ctx.binaryPath).toBeUndefined();
  expect(ctx.devMode).toBeUndefined();
  expect(ctx.exitProcess).toBeUndefined();
  expect(ctx.coordinatedUpgradeDeps).toBeUndefined();
});

test('buildLoopOptions: maps required and optional loop parameters', () => {
  const deps = makeMockDeps({
    captureIntervalMs: 100,
    drainIntervalMs: 200,
    heartbeatIntervalMs: 300,
    onCaptureComplete: () => {},
    onDrainComplete: () => {},
    onHeartbeatComplete: () => {},
    xstateInspect: true,
  });

  const opts = requireDefined(buildLoopOptions(deps));
  expect(opts.abortSignal).toBe(deps.abortSignal);
  expect(opts.captureIntervalMs).toBe(100);
  expect(opts.drainIntervalMs).toBe(200);
  expect(opts.heartbeatIntervalMs).toBe(300);
  expect(opts.onCaptureComplete).toBe(deps.onCaptureComplete);
  expect(opts.onDrainComplete).toBe(deps.onDrainComplete);
  expect(opts.onHeartbeatComplete).toBe(deps.onHeartbeatComplete);
  expect(opts.xstateInspect).toBe(true);
});

test('buildLoopOptions: handles loop options without optional settings', () => {
  const deps = makeMockDeps();
  const opts = requireDefined(buildLoopOptions(deps));
  expect(opts.abortSignal).toBe(deps.abortSignal);
  expect(opts.captureIntervalMs).toBeUndefined();
  expect(opts.drainIntervalMs).toBeUndefined();
  expect(opts.heartbeatIntervalMs).toBeUndefined();
  expect(opts.onCaptureComplete).toBeUndefined();
  expect(opts.onDrainComplete).toBeUndefined();
  expect(opts.onHeartbeatComplete).toBeUndefined();
  expect(opts.xstateInspect).toBeUndefined();
});

test('buildDaemonContexts: combines contexts correctly', () => {
  const blank = (): unknown => ({});
  const capture = blank() as Parameters<typeof buildDaemonContexts>[0]['capture'];
  const drain = blank() as Parameters<typeof buildDaemonContexts>[0]['drain'];
  const heartbeat = blank() as Parameters<typeof buildDaemonContexts>[0]['heartbeat'];

  const combined = buildDaemonContexts({ capture, drain, heartbeat });
  expect(combined.capture).toBe(capture);
  expect(combined.drain).toBe(drain);
  expect(combined.heartbeat).toBe(heartbeat);
});
