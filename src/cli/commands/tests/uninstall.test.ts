import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUninstall } from 'cli/commands/uninstall.ts';
import type { UninstallCommandDeps } from 'cli/commands/uninstall.ts';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { deriveHostId } from 'core/system';
import {
  writeConfigToFile,
  NEST_INGEST_URL,
  NEST_REGISTER_HOST_ID_URL,
  NEST_VERIFY_KEY_URL,
  NEST_WATERMARKS_URL,
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
  DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
  DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
} from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';

const TEST_MACHINE_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const TEST_USER_ID = 'u_1';
const HOST_ID = deriveHostId(TEST_MACHINE_UUID, TEST_USER_ID);

interface FakeManagerCalls {
  stop: number;
  unregister: number;
  isRegistered: number;
}

function fakeManager(
  overrides: {
    registered?: boolean;
    stopThrows?: boolean;
    unregisterThrows?: boolean;
  } = {},
): { sm: ServiceManager; calls: FakeManagerCalls } {
  const calls: FakeManagerCalls = { stop: 0, unregister: 0, isRegistered: 0 };
  const sm: ServiceManager = {
    isRegistered: async () => {
      calls.isRegistered++;
      return overrides.registered ?? true;
    },
    isRunning: async () => false,
    ensureRegistered: async () => undefined,
    start: async () => undefined,
    stop: async () => {
      calls.stop++;
      if (overrides.stopThrows === true) throw new Error('stop-broken');
    },
    restart: async () => undefined,
    unregister: async () => {
      calls.unregister++;
      if (overrides.unregisterThrows === true) throw new Error('unregister-broken');
    },
  };
  return { sm, calls };
}

let tmpRoot: string;
let configDirPath: string;
let logDirPath: string;
let configPath: string;
let serviceUnitPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'proxai-cli-uninstall-'));
  configDirPath = join(tmpRoot, '.proxai');
  logDirPath = join(tmpRoot, 'logs');
  await mkdir(configDirPath, { recursive: true });
  await mkdir(logDirPath, { recursive: true });
  configPath = join(configDirPath, 'config.toml');
  serviceUnitPath = join(tmpRoot, 'unit.plist');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeConfig(installSource: InstallSource = 'github_release'): Promise<void> {
  const config: GatewayConfig = {
    account: {
      apiKey: 'abc-123-secret',
      userId: TEST_USER_ID,
      hostId: HOST_ID,
      installedAt: '2026-04-29T10:42:00.123Z',
      installSource,
    },
    backend: {
      ingestUrl: NEST_INGEST_URL,
      verifyKeyUrl: NEST_VERIFY_KEY_URL,
      watermarksUrl: NEST_WATERMARKS_URL,
      registerHostIdUrl: NEST_REGISTER_HOST_ID_URL,
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: join(configDirPath, 'buffer.db'),
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
      initialScanWindowDays: DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
      uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
    },
    logging: { level: 'info', logDir: logDirPath },
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
  };
  await writeConfigToFile(config, configPath);
}

function depsFor(sm: ServiceManager, promptOpts: { reset?: boolean } = {}): UninstallCommandDeps {
  return {
    output: captureOutput(),
    prompts: scriptedPrompts(promptOpts),
    configPath,
    configDir: configDirPath,
    logDir: logDirPath,
    serviceUnitPath,
    serviceManager: sm,
    configExists: () => Bun.file(configPath).exists(),
  };
}

test('idempotent: returns ok and prints "no installation found" when nothing exists', async () => {
  const { sm, calls } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.msg === 'no installation found')).toBe(true);
  expect(calls.stop).toBe(0);
  expect(calls.unregister).toBe(0);
});

test('idempotent: skips when config absent, no service unit file, and not registered', async () => {
  await rm(serviceUnitPath, { force: true });
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
  const { sm, calls } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(0);
  expect(calls.unregister).toBe(0);
});

test('proceeds when only the service unit file exists (no config, not registered)', async () => {
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(calls.unregister).toBe(1);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
});

test('stop + unregister + unit-file removal on a fresh install', async () => {
  await writeConfig('github_release');
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(calls.unregister).toBe(1);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
  expect(output.lines.some((l) => l.msg === 'daemon stopped')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'service unregistered')).toBe(true);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled')).toBe(true);
  // Local state preserved without --reset.
  expect(await Bun.file(configPath).exists()).toBe(true);
});

test('swallows stop errors and continues with unregister', async () => {
  await writeConfig();
  const { sm, calls } = fakeManager({ stopThrows: true });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(calls.unregister).toBe(1);
  expect(output.lines.some((l) => l.msg === 'daemon was not running')).toBe(true);
});

test('swallows unregister errors and continues with file removal', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager({ unregisterThrows: true });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(calls.unregister).toBe(1);
  expect(output.lines.some((l) => l.msg === 'service was not registered')).toBe(true);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
});

test('--reset requires confirmation; abort returns exit 5 and preserves configDir', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm, { reset: false }), output }, { reset: true });
  expect(result.exitCode).toBe(5);
  expect(await Bun.file(configPath).exists()).toBe(true);
  expect(output.lines.some((l) => l.msg === 'reset aborted')).toBe(true);
});

test('--reset confirmed wipes configDir and logDir', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  await writeFile(join(logDirPath, 'app.log'), 'log content');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm, { reset: true }), output }, { reset: true });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(join(logDirPath, 'app.log')).exists()).toBe(false);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'local state wiped')).toBe(
    true,
  );
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled and reset')).toBe(
    true,
  );
});

test('--reset --yes skips the confirmation prompt and wipes state', async () => {
  await writeConfig();
  await writeFile(join(logDirPath, 'app.log'), 'log content');
  const { sm } = fakeManager();
  // No `reset` answer scripted: scriptedPrompts.confirmReset would throw if called.
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { reset: true, yes: true });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(join(logDirPath, 'app.log')).exists()).toBe(false);
});

test('binary-removal hint: github_release maps to rm $(which proxai-gateway)', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) =>
        l.level === 'info' &&
        l.msg === 'to remove the binary itself, run: rm $(which proxai-gateway)',
    ),
  ).toBe(true);
});

test('binary-removal hint: brew maps to brew uninstall', async () => {
  await writeConfig('brew');
  const { sm } = fakeManager();
  const output = captureOutput();
  await runUninstall({ ...depsFor(sm), output });
  expect(
    output.lines.some(
      (l) =>
        l.level === 'info' &&
        l.msg === 'to remove the binary itself, run: brew uninstall proxai-gateway',
    ),
  ).toBe(true);
});

test.each(['npm', 'pnpm', 'yarn', 'bun'] as const)(
  'binary-removal hint: %s maps to <pm> uninstall -g',
  async (pm) => {
    await writeConfig(pm);
    const { sm } = fakeManager();
    const output = captureOutput();
    await runUninstall({ ...depsFor(sm), output });
    expect(
      output.lines.some(
        (l) =>
          l.level === 'info' &&
          l.msg === `to remove the binary itself, run: ${pm} uninstall -g @proxai/gateway`,
      ),
    ).toBe(true);
  },
);

test('binary-removal hint with --reset: install_source captured before wipe', async () => {
  await writeConfig('brew');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { reset: true, yes: true });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(
    output.lines.some(
      (l) =>
        l.level === 'info' &&
        l.msg === 'to remove the binary itself, run: brew uninstall proxai-gateway',
    ),
  ).toBe(true);
});

test('generic hint when config cannot be loaded', async () => {
  // No config file written but service unit file exists, so we don't return early.
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm } = fakeManager({ registered: false });
  const output = captureOutput();
  await runUninstall({ ...depsFor(sm), output });
  expect(
    output.lines.some(
      (l) =>
        l.level === 'info' &&
        l.msg ===
          'remove the binary using your package manager (npm, brew, etc.) or rm $(which proxai-gateway)',
    ),
  ).toBe(true);
});

test('generic hint when loadConfig throws', async () => {
  await writeConfig('npm');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({
    ...depsFor(sm),
    output,
    loadConfig: () => Promise.reject(new Error('cannot parse')),
  });
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) =>
        l.level === 'info' &&
        l.msg ===
          'remove the binary using your package manager (npm, brew, etc.) or rm $(which proxai-gateway)',
    ),
  ).toBe(true);
});

test('no service unit file: skips file removal cleanly', async () => {
  await writeConfig();
  await rm(serviceUnitPath, { force: true });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
});

test('serviceUnitPath null: skips unit-file removal', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({
    ...depsFor(sm),
    output,
    serviceUnitPath: null,
  });
  expect(result.exitCode).toBe(0);
});

test('per-platform smoke: stop + unregister called regardless of platform shim', async () => {
  // The actual platform-specific commands live in service-manager. Here we just
  // confirm the command invokes stop + unregister on whatever ServiceManager
  // is wired in.
  for (const _platform of ['darwin', 'linux', 'win32'] as const) {
    await writeConfig();
    await writeFile(serviceUnitPath, '<plist/>');
    const { sm, calls } = fakeManager();
    const result = await runUninstall(depsFor(sm));
    expect(result.exitCode).toBe(0);
    expect(calls.stop).toBe(1);
    expect(calls.unregister).toBe(1);
    await rm(configPath, { force: true });
    await rm(serviceUnitPath, { force: true });
  }
});

test('isRegistered throw treated as not-registered (idempotent path)', async () => {
  // Service throws on isRegistered (e.g. command not found). With no config and
  // no unit file, we should exit cleanly via the idempotent path.
  await rm(serviceUnitPath, { force: true });
  const sm: ServiceManager = {
    isRegistered: async () => {
      throw new Error('launchctl not found');
    },
    isRunning: async () => false,
    ensureRegistered: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => undefined,
    unregister: async () => undefined,
  };
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.msg === 'no installation found')).toBe(true);
});

test('unit-file removal swallows ENOENT silently', async () => {
  await writeConfig();
  // Unit file does not exist; should not warn.
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.level === 'warn')).toBe(false);
});
