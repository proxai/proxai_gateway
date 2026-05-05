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
    hostId: '01HZ-test-host',
    installedAt: '2026-04-28T22:30:00Z',
    installSource: 'bun',
  },
  backend: {
    ingestUrl: 'https://nest.proxai.co/v1/raw_records',
    authValidateUrl: 'https://nest.proxai.co/v1/auth/validate',
    healthUrl: 'https://nest.proxai.co/v1/health',
    latestVersionUrl: 'https://nest.proxai.co/v1/gateway/latest_version',
    allowedHostsUrl: 'https://nest.proxai.co/v1/api-keys',
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
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-config-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('serialize -> parse round-trips a fully-populated config', () => {
  const text = serializeConfig(fullConfig);
  const restored = loadConfigFromString(text);
  expect(restored).toEqual(fullConfig);
});

test('serialize produces valid TOML the validator accepts', () => {
  const text = serializeConfig(fullConfig);
  expect(text).toContain('[account]');
  expect(text).toContain('[backend]');
  expect(text).toContain('[capture]');
  expect(text).toContain('[logging]');
  expect(text).toContain('[stale_binary]');
});

test('writeConfigToFile -> loadConfigFromFile preserves config', async () => {
  const filePath = join(dir, 'config.toml');
  await writeConfigToFile(fullConfig, filePath);
  const loaded = await loadConfigFromFile(filePath);
  expect(loaded).toEqual(fullConfig);
});

test('loadConfigFromString rejects malformed TOML', () => {
  expect(() => loadConfigFromString('this is = not = valid')).toThrow();
});

test('loadConfigFromFile rejects missing file', async () => {
  await expect(loadConfigFromFile(join(dir, 'no-such-file.toml'))).rejects.toThrow();
});

test('serialized output is accepted by the loader without throwing', () => {
  const text = serializeConfig(fullConfig);
  expect(() => loadConfigFromString(text)).not.toThrow();
});
