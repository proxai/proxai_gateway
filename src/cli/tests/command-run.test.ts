import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDaemon } from 'cli/command-run.ts';
import { captureOutput } from 'cli/output.ts';
import type { GatewayConfig } from 'services/config';

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
      hostId: 'h_test',
      installedAt: '2026-04-29T10:42:00.123Z',
      installSource: 'github_release',
    },
    backend: {
      ingestUrl: 'https://api.example.com/v1/raw_records',
      authValidateUrl: 'https://api.example.com/v1/auth/validate',
      healthUrl: 'https://api.example.com/v1/health',
      latestVersionUrl: 'https://api.example.com/v1/gateway/latest_version',
      allowedHostsUrl: 'https://api.example.com/v1/api-keys',
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

test('starts the loop, runs at least one cycle, and exits cleanly on abort', async () => {
  const config = makeConfig();
  const ctrl = new AbortController();
  const out = captureOutput();
  let cycles = 0;
  const promise = runDaemon({
    output: out,
    config,
    pauseSentinelPath: join(dir, 'PAUSED'),
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
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
    abortSignal: ctrl.signal,
    gatewayVersion: 'gw-test',
    sources: [],
  });
  expect(result.exitCode).toBe(0);
});
