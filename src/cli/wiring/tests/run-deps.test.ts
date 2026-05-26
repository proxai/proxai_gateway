import { expect, test } from 'bun:test';

import { buildRunDeps } from 'cli/wiring/run-deps.ts';
import {
  makeTestGatewayConfig,
  TEST_ACCOUNT_CONFIG,
  TEST_CAPTURE_CONFIG,
} from 'services/config/tests/test-config.ts';

const cfg = makeTestGatewayConfig({
  account: { ...TEST_ACCOUNT_CONFIG, installSource: 'github_release' },
  capture: { ...TEST_CAPTURE_CONFIG, bufferPath: '/tmp/b.db' },
});

test('buildRunDeps: wires sentinels, version strings, abort, exitProcess', () => {
  const ctrl = new AbortController();
  let exited = false;
  const deps = buildRunDeps({
    config: cfg,
    abortSignal: ctrl.signal,
    binaryPath: '/bin/p',
    exitProcess: () => {
      exited = true;
    },
  });
  expect(deps.config).toBe(cfg);
  expect(deps.abortSignal).toBe(ctrl.signal);
  expect(deps.binaryPath).toBe('/bin/p');
  expect(deps.installSource).toBe('github_release');
  expect(deps.devMode).toBe(false);
  expect(typeof deps.gatewayVersion).toBe('string');
  expect(typeof deps.currentVersion).toBe('string');
  deps.exitProcess?.();
  expect(exited).toBe(true);
});
