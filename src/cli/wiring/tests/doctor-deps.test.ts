import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildDoctorDeps } from 'cli/wiring/doctor-deps.ts';

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

const profileCtx = buildProfileContext('prod');

test('buildDoctorDeps wires profile-derived paths and service manager', () => {
  const deps = buildDoctorDeps({ serviceManager: sm, platform: 'linux', profileCtx });
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

test('buildDoctorDeps falls back to process.platform when platform omitted', () => {
  const deps = buildDoctorDeps({ serviceManager: null, profileCtx });
  expect(deps.serviceManager).toBeNull();
  expect(deps.platform).toBe(process.platform);
});
