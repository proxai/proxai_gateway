import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildLogsDeps } from 'cli/wiring/logs-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { openBufferDb } from 'services/buffer';
import { writeConfigToFile } from 'services/config';
import type { GatewayConfig } from 'services/config';

let dir: string;
let priorRoot: string | undefined;

function sampleConfig(bufferPath: string, logDir: string): GatewayConfig {
  return {
    account: {
      apiKey: 'key',
      userId: 'user',
      hostId: 'host',
      installedAt: new Date(0).toISOString(),
      installSource: 'github_release',
    },
    backend: {
      ingestUrl: 'https://example.test/ingest',
      verifyKeyUrl: 'https://example.test/verify',
      watermarksUrl: 'https://example.test/watermarks',
      registerHostIdUrl: 'https://example.test/register',
    },
    capture: {
      pollIntervalSec: 120,
      bufferPath,
      receiptRetentionDays: 7,
      failedRetentionDays: 7,
      bufferSoftPauseBytes: 50,
      bufferSoftResumeBytes: 45,
      uploadMaxBatchesPerSec: 1,
      uploadMaxBytesPerMinute: 1,
      uploadBackoffOn429Multiplier: 2,
    },
    logging: { level: 'info', logDir },
    staleBinary: { warnAfterDays: 30, pauseAfterDays: 60 },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-logs-deps-'));
  priorRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];
  process.env['PROXAI_TEST_PROFILE_ROOT'] = dir;
});

afterEach(async () => {
  if (priorRoot === undefined) {
    delete process.env['PROXAI_TEST_PROFILE_ROOT'];
  } else {
    process.env['PROXAI_TEST_PROFILE_ROOT'] = priorRoot;
  }
  await rmRecursive(dir);
}, 30000);

test('buildLogsDeps opens the config buffer_path and returns a working cleanup', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  await mkdir(profileCtx.configDir, { recursive: true });
  const configuredBuffer = join(profileCtx.configDir, 'moved-buffer.db');
  openBufferDb(configuredBuffer).close();
  await writeConfigToFile(
    sampleConfig(configuredBuffer, join(profileCtx.configDir, 'logs')),
    profileCtx.configFilePath,
  );
  const { deps, cleanup } = await buildLogsDeps({ profileCtx });
  expect(deps.output).toBeDefined();
  expect(deps.buffer).not.toBeNull();
  expect(() => cleanup()).not.toThrow();
});

test('buildLogsDeps falls back to profile buffer path when no config exists', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  await mkdir(profileCtx.configDir, { recursive: true });
  openBufferDb(profileCtx.bufferDbPath).close();
  const { deps, cleanup } = await buildLogsDeps({ profileCtx });
  expect(deps.buffer).not.toBeNull();
  expect(() => cleanup()).not.toThrow();
});

test('buildLogsDeps sets buffer to null when the resolved path cannot be opened', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  const { deps, cleanup } = await buildLogsDeps({ profileCtx });
  expect(deps.buffer).toBeNull();
  expect(() => cleanup()).not.toThrow();
});
