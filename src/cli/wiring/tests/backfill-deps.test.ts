import { expect, test } from 'bun:test';

import type { ServiceManager } from 'cli/service-manager.ts';
import { buildBackfillDeps, buildBackfillOptions } from 'cli/wiring/backfill-deps.ts';
import type { GatewayConfig } from 'services/config';

const cfg = { capture: { bufferPath: '/tmp/b.db' } } as GatewayConfig;

const sm = {
  ensureRegistered: async () => {},
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  unregister: async () => {},
  isRegistered: async () => false,
  isRunning: async () => true,
  runtimeInfo: async () => ({ pid: null, startedAt: null }),
} satisfies ServiceManager;

test('buildBackfillDeps: wires sentinels and gatewayVersion when serviceManager is null', () => {
  const deps = buildBackfillDeps({ config: cfg, serviceManager: null });
  expect(deps.config).toBe(cfg);
  expect(typeof deps.pauseSentinelPath).toBe('string');
  expect(typeof deps.gatewayVersion).toBe('string');
  expect(deps.gatewayVersion.length).toBeGreaterThan(0);
  expect('isDaemonRunning' in deps).toBe(false);
});

test('buildBackfillDeps: includes isDaemonRunning when serviceManager is provided', async () => {
  const deps = buildBackfillDeps({ config: cfg, serviceManager: sm });
  expect(typeof deps.isDaemonRunning).toBe('function');
  await expect(deps.isDaemonRunning!()).resolves.toBe(true);
});

test('buildBackfillOptions: forwards since', () => {
  expect(buildBackfillOptions({ since: '90d' })).toEqual({ since: '90d' });
});
