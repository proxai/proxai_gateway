import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDaemon } from 'cli/commands/run.ts';
import { captureOutput } from 'cli/output.ts';
import { countCursors, openBufferDb, setCursor } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-run-'));
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
    },
    capture: {
      pollIntervalSec: 60,
      bufferPath: join(dir, 'buffer.db'),
      bufferMaxBytes: 1_048_576,
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
    }) as typeof globalThis.fetch,
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
    onCycleComplete: () => {
      cycles++;
      ctrl.abort();
    },
  });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(cycles).toBeGreaterThanOrEqual(1);
  expect(out.lines.some((l) => l.msg.includes('starting poll loop'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('poll loop exited'))).toBe(true);
});

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
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCycleComplete: () => ctrl.abort(),
  });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(log.watermarkCalls).toBe(1);

  // Verify the cursor landed in the buffer.
  const buffer = openBufferDb(config.capture.bufferPath);
  try {
    expect(countCursors(buffer)).toBe(1);
  } finally {
    buffer.close();
  }
});

test('non-empty cursor table skips the pre-flight sync', async () => {
  const config = makeConfig();
  // Pre-populate a cursor before the daemon starts so countCursors > 0.
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
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCycleComplete: () => ctrl.abort(),
  });
  expect(result.exitCode).toBe(0);
  expect(log.watermarkCalls).toBe(0);
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
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    httpClient,
    sources: [],
    onCycleComplete: () => ctrl.abort(),
  });
  expect(result.exitCode).toBe(0);
});
