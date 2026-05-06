import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serializeConfig, writeConfigToFile, type GatewayConfig } from 'services/config';

const fullConfig: GatewayConfig = {
  account: {
    apiKey: 'pxg_live_secret',
    userId: 'u_1',
    hostId: '01HZ-test-host',
    installedAt: '2026-04-28T22:30:00Z',
    installSource: 'bun',
  },
  backend: {
    ingestUrl: 'https://nest.proxai.co/v1/raw_records',
    verifyKeyUrl: 'https://nest.proxai.co/ingestion/verify-key',
    watermarksUrl: 'https://nest.proxai.co/v1/watermarks',
  },
  capture: {
    pollIntervalSec: 300,
    bufferPath: '/Users/test/.proxai/buffer.db',
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    bufferSoftPauseBytes: 700 * 1024 * 1024,
    bufferSoftResumeBytes: 600 * 1024 * 1024,
    initialScanWindowDays: 30,
    uploadMaxBatchesPerSec: 5,
    uploadMaxBytesPerMinute: 50 * 1024 * 1024,
    uploadBackoffOn429Multiplier: 2,
  },
  logging: {
    level: 'info',
    logDir: '/Users/test/Library/Logs/proxai-gateway',
  },
  staleBinary: {
    warnAfterDays: 90,
    pauseAfterDays: 180,
  },
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-config-writer-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('serializeConfig produces TOML with all five sections', () => {
  const text = serializeConfig(fullConfig);
  expect(text).toContain('[account]');
  expect(text).toContain('[backend]');
  expect(text).toContain('[capture]');
  expect(text).toContain('[logging]');
  expect(text).toContain('[stale_binary]');
});

test('serializeConfig translates camelCase keys to snake_case', () => {
  const text = serializeConfig(fullConfig);
  expect(text).toContain('api_key');
  expect(text).toContain('user_id');
  expect(text).toContain('host_id');
  expect(text).toContain('installed_at');
  expect(text).toContain('install_source');
  expect(text).toContain('poll_interval_sec');
  expect(text).toContain('receipt_retention_days');
  expect(text).toContain('failed_retention_days');
  expect(text).toContain('buffer_soft_pause_bytes');
  expect(text).toContain('buffer_soft_resume_bytes');
  expect(text).toContain('warn_after_days');
  expect(text).toContain('pause_after_days');
});

test('writeConfigToFile creates the file', async () => {
  const filePath = join(dir, 'created.toml');
  await writeConfigToFile(fullConfig, filePath);
  expect(await Bun.file(filePath).exists()).toBe(true);
});

test('writeConfigToFile clamps mode to 0600 on Unix', async () => {
  if (process.platform === 'win32') return;
  const filePath = join(dir, 'mode.toml');
  await writeConfigToFile(fullConfig, filePath);
  const s = await stat(filePath);
  expect(s.mode & 0o777).toBe(0o600);
});
