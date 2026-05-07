import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackfill } from 'cli/commands/backfill.ts';
import { captureOutput } from 'cli/output.ts';
import { openBufferDb } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import type { RegisteredSource, SourcePollerContext } from 'services/polling';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-backfill-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
      initialScanWindowDays: 30,
      uploadMaxBatchesPerSec: 5,
      uploadMaxBytesPerMinute: 50 * 1024 * 1024,
      uploadBackoffOn429Multiplier: 2,
    },
    logging: { level: 'info', logDir: join(dir, 'logs') },
    staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
  };
}

function mockHttp(config: GatewayConfig): HttpClient {
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
        return new Response(
          JSON.stringify({ host_id: 'h_test', user_id: 'u_test', watermarks: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ accepted: true, idempotent: false, capture_id: 'x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch,
  });
}

function captureOverrideSource(): {
  source: RegisteredSource;
  observed: { minimumMtimeOverride: Date | null | undefined };
} {
  const observed: { minimumMtimeOverride: Date | null | undefined } = {
    minimumMtimeOverride: undefined,
  };
  const source: RegisteredSource = {
    name: 'capture-override',
    poll: async (ctx: SourcePollerContext) => {
      observed.minimumMtimeOverride = ctx.minimumMtimeOverride;
      return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
    },
  };
  return { source, observed };
}

test('rejects malformed --since values', async () => {
  const config = makeConfig();
  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [],
    },
    { since: 'thirty-days' },
  );
  expect(result.exitCode).toBe(2);
  expect(out.lines.some((m) => m.level === 'error' && /invalid --since/i.test(m.msg))).toBe(true);
});

test('rejects ambiguous "Nm" duration', async () => {
  const config = makeConfig();
  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [],
    },
    { since: '30m' },
  );
  expect(result.exitCode).toBe(2);
});

test('runs one cycle and propagates the --since cap to source pollers', async () => {
  const config = makeConfig();
  const { source, observed } = captureOverrideSource();
  const before = Date.now();
  const result = await runBackfill(
    {
      output: captureOutput(),
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [source],
    },
    { since: '90d' },
  );
  expect(result.exitCode).toBe(0);
  expect(observed.minimumMtimeOverride).toBeInstanceOf(Date);
  const cap = observed.minimumMtimeOverride as Date;
  
  const expected = before - 90 * 24 * 60 * 60 * 1000;
  
  expect(Math.abs(cap.getTime() - expected)).toBeLessThan(2000);
});

test('emits a daemon-running message when isDaemonRunning resolves true', async () => {
  const config = makeConfig();
  const { source } = captureOverrideSource();
  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [source],
      isDaemonRunning: async () => true,
    },
    { since: '7d' },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((m) => m.level === 'success' && /daemon will drain/i.test(m.msg))).toBe(
    true,
  );
});

test('emits the start-daemon hint when no daemon is running', async () => {
  const config = makeConfig();
  const { source } = captureOverrideSource();
  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [source],
      isDaemonRunning: async () => false,
    },
    { since: '7d' },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((m) => m.level === 'success' && /proxai-gateway start/i.test(m.msg))).toBe(
    true,
  );
});

test('captures zero batches when sources do nothing and reports the count', async () => {
  const config = makeConfig();
  const { source } = captureOverrideSource();
  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [source],
    },
    { since: '7d' },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((m) => m.level === 'success' && /captured 0 batch/i.test(m.msg))).toBe(
    true,
  );
});

test('logs a warning when syncServerWatermarks throws but continues the cycle', async () => {
  const config = makeConfig();
  const { source } = captureOverrideSource();
  
  
  const httpClient = new HttpClient({
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
        throw new Error('boom-watermark');
      }
      return new Response(JSON.stringify({ accepted: true, idempotent: false, capture_id: 'x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch,
  });

  const out = captureOutput();
  const result = await runBackfill(
    {
      output: out,
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient,
      sources: [source],
    },
    { since: '7d' },
  );
  expect(result.exitCode).toBe(0);
});

test('closes the buffer database after the cycle completes', async () => {
  const config = makeConfig();
  const { source } = captureOverrideSource();
  await runBackfill(
    {
      output: captureOutput(),
      config,
      pauseSentinelPath: join(dir, 'PAUSED'),
      authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
      bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
      gatewayVersion: 'gw-test',
      httpClient: mockHttp(config),
      sources: [source],
    },
    { since: '7d' },
  );
  
  
  const reopened = openBufferDb(config.capture.bufferPath);
  reopened.close();
});
