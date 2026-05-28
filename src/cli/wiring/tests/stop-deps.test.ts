import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildStopDeps } from 'cli/wiring/stop-deps.ts';

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

test('buildStopDeps: returns deps with the provided service manager', () => {
  const deps = buildStopDeps({ serviceManager: sm, profileCtx });
  expect(typeof deps.output.info).toBe('function');
  expect(deps.serviceManager).toBe(sm);
  expect(typeof deps.sessionStoppedSentinelPath).toBe('string');
  expect(deps.sessionStoppedSentinelPath.length).toBeGreaterThan(0);
});
