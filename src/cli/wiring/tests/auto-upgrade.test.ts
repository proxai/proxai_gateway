import { expect, test } from 'bun:test';

import { autoUpgradeFromConfig, type RunAutoUpgradeFn } from 'cli/wiring/auto-upgrade.ts';
import type { GatewayConfig } from 'services/config';

test('autoUpgradeFromConfig: returns silently when loadConfig rejects', async () => {
  let runnerCalled = false;
  const runner: RunAutoUpgradeFn = async () => {
    runnerCalled = true;
  };
  await autoUpgradeFromConfig({
    binaryPath: '/bin/p',
    currentVersion: '1.0.0',
    devMode: false,
    loadConfig: () => Promise.reject(new Error('no config')),
    exitProcess: () => {},
    runAutoUpgrade: runner,
  });
  expect(runnerCalled).toBe(false);
});

test('autoUpgradeFromConfig: forwards installSource from config to runAutoUpgrade', async () => {
  let captured: Parameters<RunAutoUpgradeFn>[0] | undefined;
  const runner: RunAutoUpgradeFn = async (deps) => {
    captured = deps;
  };
  const cfg = { account: { installSource: 'brew' } } as GatewayConfig;
  await autoUpgradeFromConfig({
    binaryPath: '/bin/p',
    currentVersion: '1.2.3',
    devMode: false,
    loadConfig: () => Promise.resolve(cfg),
    exitProcess: () => {},
    runAutoUpgrade: runner,
  });
  expect(captured?.installSource).toBe('brew');
  expect(captured?.binaryPath).toBe('/bin/p');
  expect(captured?.currentVersion).toBe('1.2.3');
  expect(captured?.devMode).toBe(false);
});

test('autoUpgradeFromConfig: omits installSource when undefined in config', async () => {
  let captured: Parameters<RunAutoUpgradeFn>[0] | undefined;
  const runner: RunAutoUpgradeFn = async (deps) => {
    captured = deps;
  };
  const cfg = { account: {} } as GatewayConfig;
  await autoUpgradeFromConfig({
    binaryPath: '/bin/p',
    currentVersion: '1.2.3',
    devMode: true,
    loadConfig: () => Promise.resolve(cfg),
    exitProcess: () => {},
    runAutoUpgrade: runner,
  });
  expect(captured).toBeDefined();
  expect('installSource' in (captured ?? {})).toBe(false);
  expect(captured?.devMode).toBe(true);
});
