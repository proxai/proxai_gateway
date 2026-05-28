import { expect, test } from 'bun:test';

import { buildRunDeps } from 'cli/wiring/run-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import {
  makeTestGatewayConfig,
  TEST_ACCOUNT_CONFIG,
  TEST_CAPTURE_CONFIG,
} from 'services/config/tests/test-config.ts';

const cfg = makeTestGatewayConfig({
  account: { ...TEST_ACCOUNT_CONFIG, installSource: 'github_release' },
  capture: { ...TEST_CAPTURE_CONFIG, bufferPath: '/tmp/b.db' },
});

const prodCtx = buildProfileContext('prod');

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
    profileCtx: prodCtx,
  });
  expect(deps.config).toBe(cfg);
  expect(deps.abortSignal).toBe(ctrl.signal);
  expect(deps.binaryPath).toBe('/bin/p');
  expect(deps.installSource).toBe('github_release');
  expect(deps.devMode).toBe(false);
  expect(typeof deps.gatewayVersion).toBe('string');
  expect(typeof deps.currentVersion).toBe('string');
  expect(deps.profileCtx).toBe(prodCtx);
  deps.exitProcess?.();
  expect(exited).toBe(true);
  expect(deps.xstateInspect).toBeUndefined();
});

test('buildRunDeps: preserves xstateInspect when provided', () => {
  const ctrl = new AbortController();
  const deps = buildRunDeps({
    config: cfg,
    abortSignal: ctrl.signal,
    binaryPath: '/bin/p',
    exitProcess: () => {},
    xstateInspect: true,
    profileCtx: prodCtx,
  });
  expect(deps.xstateInspect).toBe(true);
});
