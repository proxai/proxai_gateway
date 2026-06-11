import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunDeps } from 'cli/wiring/run-deps.ts';
import { rmRecursive } from 'core/io/fs';
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

test('buildRunDeps: binds loadDesktopCliSessionIds returning a set', async () => {
  const ctrl = new AbortController();
  const deps = buildRunDeps({
    config: cfg,
    abortSignal: ctrl.signal,
    binaryPath: '/bin/p',
    exitProcess: () => {},
    profileCtx: prodCtx,
  });
  expect(typeof deps.loadDesktopCliSessionIds).toBe('function');
  const ids = await deps.loadDesktopCliSessionIds?.();
  expect(ids instanceof Set).toBe(true);
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

let profileRoot: string | undefined;
const origProfileRootEnv = process.env['PROXAI_TEST_PROFILE_ROOT'];

afterEach(async () => {
  if (origProfileRootEnv === undefined) {
    delete process.env['PROXAI_TEST_PROFILE_ROOT'];
  } else {
    process.env['PROXAI_TEST_PROFILE_ROOT'] = origProfileRootEnv;
  }
  if (profileRoot !== undefined) {
    await rmRecursive(profileRoot);
    profileRoot = undefined;
  }
});

test('buildRunDeps: wires coordinatedUpgradeDeps when non-dev and dev config exists', () => {
  profileRoot = mkdtempSync(join(tmpdir(), 'proxai-run-deps-'));
  process.env['PROXAI_TEST_PROFILE_ROOT'] = profileRoot;
  const devConfigDir = join(profileRoot, 'dev');
  mkdirSync(devConfigDir, { recursive: true });
  writeFileSync(join(devConfigDir, 'config.toml'), '');

  const nonDevCtx = buildProfileContext('prod');
  const ctrl = new AbortController();
  const deps = buildRunDeps({
    config: cfg,
    abortSignal: ctrl.signal,
    binaryPath: '/bin/p',
    exitProcess: () => {},
    profileCtx: nonDevCtx,
    platform: 'linux',
  });
  expect(deps.coordinatedUpgradeDeps).toBeDefined();
});
