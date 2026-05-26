import { expect, test } from 'bun:test';

import { autoUpgradeFromConfig, type RunAutoUpgradeFn } from 'cli/wiring/auto-upgrade.ts';
import { makeTestGatewayConfig, TEST_ACCOUNT_CONFIG } from 'services/config/tests/test-config.ts';

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
  const cfg = makeTestGatewayConfig({ account: { ...TEST_ACCOUNT_CONFIG, installSource: 'brew' } });
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

test('autoUpgradeFromConfig: forwards github_release installSource from a complete config', async () => {
  let captured: Parameters<RunAutoUpgradeFn>[0] | undefined;
  const runner: RunAutoUpgradeFn = async (deps) => {
    captured = deps;
  };
  const cfg = makeTestGatewayConfig({
    account: { ...TEST_ACCOUNT_CONFIG, installSource: 'github_release' },
  });
  await autoUpgradeFromConfig({
    binaryPath: '/bin/p',
    currentVersion: '1.2.3',
    devMode: true,
    loadConfig: () => Promise.resolve(cfg),
    exitProcess: () => {},
    runAutoUpgrade: runner,
  });
  expect(captured).toBeDefined();
  expect(captured?.installSource).toBe('github_release');
  expect(captured?.devMode).toBe(true);
});
