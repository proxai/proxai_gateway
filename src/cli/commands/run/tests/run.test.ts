import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDaemon } from 'cli/commands/run';
import { captureOutput } from 'cli/output.ts';
import { countCursors, openBufferDb, setCursor } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import {
  readSessionStoppedSentinel,
  writeSessionStoppedSentinel,
} from 'services/polling/session-stopped-sentinel.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-run-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

function makeConfig(): GatewayConfig {
  return {
    account: {
      apiKey: 'pxg_test',
      userId: 'u_test',
      hostId: 'h_test',
      installedAt: '2026-04-29T10:42:00.123Z',
      installSource: 'github_release',
    },
    backend: {
      ingestUrl: 'https://api.example.com/v1/raw_records',
      verifyKeyUrl: 'https://api.example.com/ingestion/verify-key',
      watermarksUrl: 'https://api.example.com/v1/watermarks',
      registerHostIdUrl: 'https://api.example.com/v1/host-ids/register',
    },
    capture: {
      pollIntervalSec: 60,
      bufferPath: join(dir, 'buffer.db'),
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      bufferSoftPauseBytes: 700 * 1024 * 1024,
      bufferSoftResumeBytes: 600 * 1024 * 1024,
      uploadMaxBatchesPerSec: 5,
      uploadMaxBytesPerMinute: 50 * 1024 * 1024,
      uploadBackoffOn429Multiplier: 2,
    },
    logging: { level: 'info', logDir: join(dir, 'logs') },
    staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
  };
}

interface FetchLog {
  watermarkCalls: number;
}

function mockHttp(
  config: GatewayConfig,
  watermarkResponder: () => Response,
  log?: FetchLog,
): HttpClient {
  return new HttpClient({
    apiKey: config.account.apiKey,
    hostId: config.account.hostId,
    endpoints: {
      ingest: config.backend.ingestUrl,
      verifyKey: config.backend.verifyKeyUrl,
      watermarks: config.backend.watermarksUrl,
      registerHostId: config.backend.registerHostIdUrl,
    },
    fetch: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/watermarks')) {
        if (log !== undefined) log.watermarkCalls++;
        return watermarkResponder();
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as FetchFn,
  });
}

function emptyWatermarks(): Response {
  return new Response(JSON.stringify({ host_id: 'h_test', user_id: 'u_test', watermarks: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('starts the loop, runs at least one cycle, and exits cleanly on abort', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  const out = captureOutput();
  let cycles = 0;
  const promise = runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [
      {
        name: 'noop',
        poll: async () => ({
          filesProcessed: 0,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [],
        }),
      },
    ],
    captureIntervalMs: 1,
    drainIntervalMs: 1,
    heartbeatIntervalMs: 1,
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '1.0.0',
    binaryPath: '/tmp/x',
    devMode: false,
    exitProcess: () => {},
    onCaptureComplete: () => {
      cycles++;
      ctrl.abort();
    },
    onDrainComplete: () => {},
    onHeartbeatComplete: () => {},
  });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(cycles).toBeGreaterThanOrEqual(1);
  expect(out.lines.some((l) => l.msg.includes('starting capture / drain / heartbeat loops'))).toBe(
    true,
  );
  expect(out.lines.some((l) => l.msg.includes('daemon loops exited'))).toBe(true);
}, 30_000);

test('exits immediately when abort signal is already aborted', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  ctrl.abort();
  const out = captureOutput();
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [],
  });
  expect(result.exitCode).toBe(0);
});

test('empty cursor table triggers a watermark sync; populated cursors are seeded', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  const out = captureOutput();
  const log: FetchLog = { watermarkCalls: 0 };
  const httpClient = mockHttp(
    config,
    () =>
      new Response(
        JSON.stringify({
          host_id: 'h_test',
          user_id: 'u_test',
          watermarks: [
            {
              source_app: 'claude-code',
              source_path_hash: 'aaaa',
              watermark_kind: 'byte_range',
              watermark_end: 1234,
              watermark_table: null,
              last_delivered_at: '2026-04-29T10:42:00Z',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    log,
  );
  const promise = runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCaptureComplete: () => ctrl.abort(),
  });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(log.watermarkCalls).toBe(1);

  const buffer = openBufferDb(config.capture.bufferPath);
  try {
    expect(countCursors(buffer)).toBe(1);
  } finally {
    buffer.close();
  }
});

test('non-empty cursor table skips the pre-flight sync', async () => {
  const config = makeConfig();

  const seed = openBufferDb(config.capture.bufferPath);
  setCursor(seed, {
    sourceApp: 'claude-code',
    sourcePathHash: 'preexisting',
    sourcePath: '/tmp/x.jsonl',
    sourceInode: 12345,
    watermarkTable: null,
    watermarkEnd: 42,
  });
  seed.close();

  const ctrl = new AbortController();
  const out = captureOutput();
  const log: FetchLog = { watermarkCalls: 0 };
  const httpClient = mockHttp(config, emptyWatermarks, log);
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCaptureComplete: () => ctrl.abort(),
  });
  expect(result.exitCode).toBe(0);
  expect(log.watermarkCalls).toBe(0);
});

test('exits cleanly with EXIT_CODE.ok when SESSION_STOPPED matches current boot_id', async () => {
  const config = makeConfig();
  const sentinelPath = join(dir, 'SESSION_STOPPED');
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'boot-test',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const ctrl = new AbortController();
  const out = captureOutput();
  let cycles = 0;
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [
      {
        name: 'noop',
        poll: async () => {
          cycles++;
          return {
            filesProcessed: 0,
            capturedBatches: 0,
            capturedBytes: 0,
            errors: [],
          };
        },
      },
    ],
  });
  expect(result.exitCode).toBe(0);
  expect(cycles).toBe(0);

  expect(await readSessionStoppedSentinel(sentinelPath)).not.toBeNull();
});

test('deletes stale SESSION_STOPPED sentinel and proceeds when boot_id mismatches', async () => {
  const config = makeConfig();
  const sentinelPath = join(dir, 'SESSION_STOPPED');
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'old-boot',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const ctrl = new AbortController();
  const out = captureOutput();
  let cycles = 0;
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'new-boot',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [
      {
        name: 'noop',
        poll: async () => ({
          filesProcessed: 0,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [],
        }),
      },
    ],
    onCaptureComplete: () => {
      cycles++;
      ctrl.abort();
    },
  });
  expect(result.exitCode).toBe(0);
  expect(cycles).toBeGreaterThanOrEqual(1);

  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('proceeds normally when the SESSION_STOPPED sentinel does not exist', async () => {
  const config = makeConfig();
  const sentinelPath = join(dir, 'SESSION_STOPPED');
  const ctrl = new AbortController();
  const out = captureOutput();
  let cycles = 0;
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [
      {
        name: 'noop',
        poll: async () => ({
          filesProcessed: 0,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [],
        }),
      },
    ],
    onCaptureComplete: () => {
      cycles++;
      ctrl.abort();
    },
  });
  expect(result.exitCode).toBe(0);
  expect(cycles).toBeGreaterThanOrEqual(1);
});

test('readBootId failure is logged as warn and does not abort the daemon', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  const out = captureOutput();
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => {
      throw new Error('boot id unavailable');
    },
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient: mockHttp(config, emptyWatermarks),
    sources: [],
    onCaptureComplete: () => ctrl.abort(),
  });
  expect(result.exitCode).toBe(0);
});

test('watermark sync failure logs warn and does not abort the daemon', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  const out = captureOutput();
  const httpClient = mockHttp(config, () => new Response('', { status: 503 }));
  const result = await runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    readBootId: async () => 'boot-test',
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCaptureComplete: () => ctrl.abort(),
  });
  expect(result.exitCode).toBe(0);
});
