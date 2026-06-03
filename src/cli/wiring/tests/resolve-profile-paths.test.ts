import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { resolveProfilePaths } from 'cli/wiring/resolve-profile-paths.ts';
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
  dir = await mkdtemp(join(tmpdir(), 'proxai-resolve-paths-'));
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

test('returns config buffer_path and log_dir when a valid config exists', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  await mkdir(profileCtx.configDir, { recursive: true });
  const configuredBuffer = join(profileCtx.configDir, 'moved-buffer.db');
  const configuredLogDir = join(profileCtx.configDir, 'moved-logs');
  await writeConfigToFile(
    sampleConfig(configuredBuffer, configuredLogDir),
    profileCtx.configFilePath,
  );

  const resolved = await resolveProfilePaths(profileCtx);
  expect(resolved.bufferDbPath).toBe(configuredBuffer);
  expect(resolved.logDir).toBe(configuredLogDir);
});

test('falls back to profile defaults when no config file exists', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');

  const resolved = await resolveProfilePaths(profileCtx);
  expect(resolved.bufferDbPath).toBe(profileCtx.bufferDbPath);
  expect(resolved.logDir).toBe(profileCtx.logDir);
});

test('falls back to profile defaults when the config file is unreadable', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  await mkdir(profileCtx.configFilePath, { recursive: true });

  const resolved = await resolveProfilePaths(profileCtx);
  expect(resolved.bufferDbPath).toBe(profileCtx.bufferDbPath);
  expect(resolved.logDir).toBe(profileCtx.logDir);
});
