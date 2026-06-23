import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceManager } from 'cli/service-manager';
import { rmRecursive } from 'core/io/fs';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { buildDoctorDeps } from 'cli/wiring/doctor-deps.ts';
import { writeConfigToFile } from 'services/config';
import type { GatewayConfig } from 'services/config';

const sm = {
  ensureRegistered: async () => {},
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  unregister: async () => {},
  isRegistered: async () => false,
  isRunning: async () => false,
  runtimeInfo: async () => ({ pid: null, startedAt: null }),
} satisfies ServiceManager;

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
      excludedProjects: [],
    },
    logging: { level: 'info', logDir },
    staleBinary: { warnAfterDays: 30, pauseAfterDays: 60 },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-doctor-deps-'));
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

test('buildDoctorDeps wires profile-derived paths and service manager', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  const deps = await buildDoctorDeps({ serviceManager: sm, platform: 'linux', profileCtx });
  expect(deps.serviceManager).toBe(sm);
  expect(deps.platform).toBe('linux');
  expect(deps.bufferDbPath).toBe(profileCtx.bufferDbPath);
  expect(deps.configFilePath).toBe(profileCtx.configFilePath);
  expect(deps.configDirPath).toBe(profileCtx.configDir);
  expect(deps.logDirPath).toBe(profileCtx.logDir);
  expect(deps.authFailedSentinelPath).toBe(profileCtx.sentinels.authFailed);
  expect(deps.bufferFullSentinelPath).toBe(profileCtx.sentinels.bufferFull);
  expect(deps.sessionStoppedSentinelPath).toBe(profileCtx.sentinels.sessionStopped);
  expect(deps.updateAvailableSentinelPath).toBe(profileCtx.sentinels.updateAvailable);
  expect(typeof deps.nestVerifyKeyUrl).toBe('string');
  expect(deps.nestVerifyKeyUrl.length).toBeGreaterThan(0);
  expect(typeof deps.binaryPath).toBe('string');
  expect(typeof deps.currentVersion).toBe('string');
  expect(deps.output).toBeDefined();
  expect(typeof deps.output.info).toBe('function');
});

test('buildDoctorDeps uses config buffer_path and log_dir when present', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  await mkdir(profileCtx.configDir, { recursive: true });
  const configuredBuffer = join(profileCtx.configDir, 'moved-buffer.db');
  const configuredLogDir = join(profileCtx.configDir, 'moved-logs');
  await writeConfigToFile(
    sampleConfig(configuredBuffer, configuredLogDir),
    profileCtx.configFilePath,
  );
  const deps = await buildDoctorDeps({ serviceManager: sm, platform: 'linux', profileCtx });
  expect(deps.bufferDbPath).toBe(configuredBuffer);
  expect(deps.logDirPath).toBe(configuredLogDir);
});

test('buildDoctorDeps falls back to process.platform when platform omitted', async () => {
  const profileCtx: ProfileContext = buildProfileContext('prod');
  const deps = await buildDoctorDeps({ serviceManager: null, profileCtx });
  expect(deps.serviceManager).toBeNull();
  expect(deps.platform).toBe(process.platform);
});
