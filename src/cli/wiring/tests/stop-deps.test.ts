import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager';
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

test('buildStopDeps: returns deps with the provided service manager', () => {
  const deps = buildStopDeps(sm);
  expect(typeof deps.output.info).toBe('function');
  expect(deps.serviceManager).toBe(sm);
  expect(typeof deps.sessionStoppedSentinelPath).toBe('string');
  expect(deps.sessionStoppedSentinelPath.length).toBeGreaterThan(0);
});
