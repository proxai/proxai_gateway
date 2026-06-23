import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfigFromFile,
  loadConfigFromString,
  serializeConfig,
  writeConfigToFile,
  type GatewayConfig,
} from 'services/config';

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
    registerHostIdUrl: 'https://nest.proxai.co/v1/host-ids/register',
  },
  capture: {
    pollIntervalSec: 300,
    bufferPath: '/Users/test/.proxai/buffer.db',
    receiptRetentionDays: 30,
    failedRetentionDays: 30,
    bufferSoftPauseBytes: 700 * 1024 * 1024,
    bufferSoftResumeBytes: 600 * 1024 * 1024,
    uploadMaxBatchesPerSec: 5,
    uploadMaxBytesPerMinute: 50 * 1024 * 1024,
    uploadBackoffOn429Multiplier: 2,
    excludedProjects: [],
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
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-config-roundtrip-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('serializeConfig -> loadConfigFromString round-trips a fully-populated config', () => {
  const text = serializeConfig(fullConfig);
  const restored = loadConfigFromString(text);
  expect(restored).toEqual(fullConfig);
});

test('writeConfigToFile -> loadConfigFromFile round-trips through disk', async () => {
  const filePath = join(dir, 'config.toml');
  await writeConfigToFile(fullConfig, filePath);
  const loaded = await loadConfigFromFile(filePath);
  expect(loaded).toEqual(fullConfig);
});

test('excluded_projects round-trips through serialize -> load', () => {
  const cfg: GatewayConfig = {
    ...fullConfig,
    capture: { ...fullConfig.capture, excludedProjects: ['/Users/me/secret', '~/p'] },
  };
  const restored = loadConfigFromString(serializeConfig(cfg));
  expect(restored.capture.excludedProjects).toEqual(['/Users/me/secret', '~/p']);
});

test('empty excluded_projects is omitted from the serialized TOML', () => {
  expect(serializeConfig(fullConfig)).not.toContain('excluded_projects');
});
