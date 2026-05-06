import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
  },
  capture: {
    pollIntervalSec: 300,
    bufferPath: '/Users/test/.proxai/buffer.db',
    bufferMaxBytes: 524_288_000,
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
  await rm(dir, { recursive: true, force: true });
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
