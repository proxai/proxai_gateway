import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUninstall } from 'cli/commands/uninstall';
import { buildConfirmationMessage } from 'cli/commands/uninstall/confirmation-message.ts';
import type { UninstallCommandDeps } from 'cli/commands/uninstall';
import type { PackageManagerSweep, PmDetection, SweepablePm } from 'services/uninstall';
import type {
  BinaryRemovalOptions,
  BinaryRemovalResult,
  DirectBinaryRemover,
} from 'services/uninstall';
import type { PathCleanupOutcome, ShellPathCleaner } from 'services/uninstall';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import { deriveHostId } from 'core/system';
import {
  writeConfigToFile,
  nestIngestUrl,
  nestRegisterHostIdUrl,
  nestVerifyKeyUrl,
  nestWatermarksUrl,
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
  DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
  DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
} from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';
import { buildProfileContext } from 'core/io/fs/profile.ts';

const prodBaseUrl = buildProfileContext('prod').defaultNestBaseUrl;

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
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  return { sm, calls };
}

interface FakeRemoverCalls {
  remove: Array<{ execPath: string; options: BinaryRemovalOptions | undefined }>;
}

function fakeRemover(
  result: BinaryRemovalResult = { ok: true, deferred: false, message: 'removed' },
): { remover: DirectBinaryRemover; calls: FakeRemoverCalls } {
  const calls: FakeRemoverCalls = { remove: [] };
  return {
    calls,
    remover: {
      remove: async (execPath, options) => {
        calls.remove.push({ execPath, options });
        return result;
      },
    },
  };
}

interface FakeCleanerCalls {
  clean: string[];
}

function fakeCleaner(outcomes: PathCleanupOutcome[] | (() => Promise<PathCleanupOutcome[]>) = []): {
  cleaner: ShellPathCleaner;
  calls: FakeCleanerCalls;
} {
  const calls: FakeCleanerCalls = { clean: [] };
  return {
    calls,
    cleaner: {
      clean: async (installDir) => {
        calls.clean.push(installDir);
        return typeof outcomes === 'function' ? outcomes() : outcomes;
      },
    },
  };
}

let tmpRoot: string;
let configDirPath: string;
let logDirPath: string;
let devConfigDirPath: string;
let devLogDirPath: string;
let configPath: string;
let serviceUnitPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'proxai-cli-uninstall-'));
  configDirPath = join(tmpRoot, '.proxai', 'prod');
  logDirPath = join(tmpRoot, 'logs', 'prod');
  devConfigDirPath = join(tmpRoot, '.proxai', 'dev');
  devLogDirPath = join(tmpRoot, 'logs', 'dev');
  await mkdir(configDirPath, { recursive: true });
  await mkdir(logDirPath, { recursive: true });
  await mkdir(devConfigDirPath, { recursive: true });
  await mkdir(devLogDirPath, { recursive: true });
  configPath = join(configDirPath, 'config.toml');
  serviceUnitPath = join(tmpRoot, 'unit.plist');
});

afterEach(async () => {
  await rmRecursive(tmpRoot);
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
      ingestUrl: nestIngestUrl(prodBaseUrl),
      verifyKeyUrl: nestVerifyKeyUrl(prodBaseUrl),
      watermarksUrl: nestWatermarksUrl(prodBaseUrl),
      registerHostIdUrl: nestRegisterHostIdUrl(prodBaseUrl),
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: join(configDirPath, 'buffer.db'),
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
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

function depsFor(
  sm: ServiceManager,
  promptOpts: { phrase?: string | boolean } = {},
): UninstallCommandDeps {
  return {
    output: captureOutput(),
    prompts: scriptedPrompts(promptOpts),
    configPath,
    configDir: configDirPath,
    logDir: logDirPath,
    serviceUnitPath,
    serviceManager: sm,
    devServiceManager: null,
    devServiceUnitPath: null,
    devConfigDir: devConfigDirPath,
    devLogDir: devLogDirPath,
    profileRootDir: join(tmpRoot, '.proxai'),
    profileLogDirRoot: join(tmpRoot, 'logs'),
    configExists: () => Bun.file(configPath).exists(),
    isDevMode: true,
  };
}

test('idempotent: returns ok and prints "no installation found" when nothing exists', async () => {
  const { sm, calls } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
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
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(0);
  expect(calls.unregister).toBe(0);
});

test('proceeds when only the service unit file exists (no config, not registered)', async () => {
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
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
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(calls.unregister).toBe(1);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
  expect(output.lines.some((l) => l.msg === 'daemon stopped')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'service unregistered')).toBe(true);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled')).toBe(true);

  expect(await Bun.file(configPath).exists()).toBe(true);
});

test('swallows stop errors and continues with unregister', async () => {
  await writeConfig();
  const { sm, calls } = fakeManager({ stopThrows: true });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
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
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(calls.unregister).toBe(1);
  expect(output.lines.some((l) => l.msg === 'service was not registered')).toBe(true);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
});

test('plain uninstall executes softly, silently, and immediately without prompting', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({
    ...depsFor(sm, { phrase: false }),
    output,
  });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(calls.unregister).toBe(1);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
  expect(await Bun.file(configPath).exists()).toBe(true);
});

test('--reset requires typed phrase "uninstall"; matching phrase wipes', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  await writeFile(join(logDirPath, 'app.log'), 'log content');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    { ...depsFor(sm, { phrase: 'uninstall' }), output },
    { reset: true },
  );
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(join(logDirPath, 'app.log')).exists()).toBe(false);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'local state wiped')).toBe(
    true,
  );
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled and reset')).toBe(
    true,
  );
  expect(output.lines.some((l) => l.msg.includes('IMPORTANT NOTICE'))).toBe(true);
});

test('--reset: empty input aborts; configDir preserved', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm, { phrase: false }), output }, { reset: true });
  expect(result.exitCode).toBe(5);
  expect(await Bun.file(configPath).exists()).toBe(true);
  expect(output.lines.some((l) => l.msg.includes('aborted'))).toBe(true);
});

test('--reset: typing a non-matching phrase aborts', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    { ...depsFor(sm, { phrase: 'uninstall --reset' }), output },
    { reset: true },
  );
  expect(result.exitCode).toBe(5);
  expect(await Bun.file(configPath).exists()).toBe(true);
});

test('--yes skips both prompts on plain uninstall', async () => {
  await writeConfig();
  await writeFile(serviceUnitPath, '<plist/>');
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
});

test('--reset --yes skips the confirmation prompt and wipes state', async () => {
  await writeConfig();
  await writeFile(join(logDirPath, 'app.log'), 'log content');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { reset: true, yes: true });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(join(logDirPath, 'app.log')).exists()).toBe(false);
});

test('no service unit file: skips file removal cleanly', async () => {
  await writeConfig();
  await rm(serviceUnitPath, { force: true });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
});

test('serviceUnitPath null: skips unit-file removal', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    { ...depsFor(sm), output, serviceUnitPath: null },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
});

test('per-platform smoke: stop + unregister called regardless of platform shim', async () => {
  const platforms = ['darwin', 'linux', 'win32'] as const;
  await Promise.all(
    platforms.map(async (platform) => {
      const isolatedConfigDir = join(tmpRoot, platform, '.proxai', 'prod');
      const isolatedDevConfigDir = join(tmpRoot, platform, '.proxai', 'dev');
      const isolatedLogDir = join(tmpRoot, platform, 'logs', 'prod');
      const isolatedDevLogDir = join(tmpRoot, platform, 'logs', 'dev');
      await mkdir(isolatedConfigDir, { recursive: true });
      await mkdir(isolatedDevConfigDir, { recursive: true });
      await mkdir(isolatedLogDir, { recursive: true });
      await mkdir(isolatedDevLogDir, { recursive: true });
      const isolatedConfigPath = join(isolatedConfigDir, 'config.toml');
      const isolatedServiceUnitPath = join(tmpRoot, `unit-${platform}.plist`);
      const config: GatewayConfig = {
        account: {
          apiKey: 'abc-123-secret',
          userId: TEST_USER_ID,
          hostId: HOST_ID,
          installedAt: '2026-04-29T10:42:00.123Z',
          installSource: 'github_release',
        },
        backend: {
          ingestUrl: nestIngestUrl(prodBaseUrl),
          verifyKeyUrl: nestVerifyKeyUrl(prodBaseUrl),
          watermarksUrl: nestWatermarksUrl(prodBaseUrl),
          registerHostIdUrl: nestRegisterHostIdUrl(prodBaseUrl),
        },
        capture: {
          pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
          bufferPath: join(isolatedConfigDir, 'buffer.db'),
          receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
          failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
          bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
          bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
          uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
          uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
          uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
        },
        logging: { level: 'info', logDir: isolatedLogDir },
        staleBinary: {
          warnAfterDays: DEFAULT_STALE_WARN_DAYS,
          pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
        },
      };
      await writeConfigToFile(config, isolatedConfigPath);
      await writeFile(isolatedServiceUnitPath, '<plist/>');
      const { sm, calls } = fakeManager();
      const deps: UninstallCommandDeps = {
        output: captureOutput(),
        prompts: scriptedPrompts({}),
        configPath: isolatedConfigPath,
        configDir: isolatedConfigDir,
        logDir: isolatedLogDir,
        serviceUnitPath: isolatedServiceUnitPath,
        serviceManager: sm,
        devServiceManager: null,
        devServiceUnitPath: null,
        devConfigDir: isolatedDevConfigDir,
        devLogDir: isolatedDevLogDir,
        profileRootDir: join(tmpRoot, platform, '.proxai'),
        profileLogDirRoot: join(tmpRoot, platform, 'logs'),
        configExists: () => Bun.file(isolatedConfigPath).exists(),
        isDevMode: true,
      };
      const result = await runUninstall(deps, { yes: true });
      expect(result.exitCode).toBe(0);
      expect(calls.stop).toBe(1);
      expect(calls.unregister).toBe(1);
    }),
  );
});

test('isRegistered throw treated as not-registered (idempotent path)', async () => {
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
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.msg === 'no installation found')).toBe(true);
});

test('unit-file removal swallows ENOENT silently', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.level === 'warn')).toBe(false);
});

test('unit-file removal warns when unlink fails with non-ENOENT error', async () => {
  await writeConfig();
  await rm(serviceUnitPath, { force: true });
  await mkdir(serviceUnitPath, { recursive: true });
  await writeFile(join(serviceUnitPath, 'inner'), 'block-the-unlink');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) => l.level === 'warn' && l.msg.includes('could not remove service unit file'),
    ),
  ).toBe(true);
});

interface FakeSweepCalls {
  detectAll: number;
  detectBrew: number;
  uninstall: SweepablePm[];
  uninstallBrew: number;
}

function fakeSweep(opts: {
  detections?: PmDetection[];
  brew?: { available: boolean; installed: boolean };
  uninstallResult?: (name: SweepablePm) => { ok: boolean; message: string };
  uninstallBrewResult?: { ok: boolean; message: string };
  detectAllThrows?: boolean;
  detectBrewThrows?: boolean;
  uninstallThrows?: SweepablePm;
  uninstallBrewThrows?: boolean;
}): { sweep: PackageManagerSweep; calls: FakeSweepCalls } {
  const calls: FakeSweepCalls = { detectAll: 0, detectBrew: 0, uninstall: [], uninstallBrew: 0 };
  const sweep: PackageManagerSweep = {
    detectAll: async () => {
      calls.detectAll++;
      if (opts.detectAllThrows === true) throw new Error('detect-all-broken');
      return (
        opts.detections ?? [
          { name: 'npm', available: false, installed: false },
          { name: 'pnpm', available: false, installed: false },
          { name: 'yarn', available: false, installed: false },
          { name: 'bun', available: false, installed: false },
        ]
      );
    },
    uninstall: async (name) => {
      calls.uninstall.push(name);
      if (opts.uninstallThrows === name) throw new Error(`${name}-throw`);
      return opts.uninstallResult?.(name) ?? { ok: true, message: `removed via ${name}` };
    },
    detectBrew: async () => {
      calls.detectBrew++;
      if (opts.detectBrewThrows === true) throw new Error('brew-detect-broken');
      return opts.brew ?? { available: false, installed: false };
    },
    uninstallBrew: async () => {
      calls.uninstallBrew++;
      if (opts.uninstallBrewThrows === true) throw new Error('brew-uninstall-throw');
      return opts.uninstallBrewResult ?? { ok: true, message: 'removed via brew' };
    },
  };
  return { sweep, calls };
}

test('sweep: removes via every installed PM and reports each', async () => {
  await writeConfig('npm');
  await writeFile(serviceUnitPath, '<plist/>');
  const { sweep, calls } = fakeSweep({
    detections: [
      { name: 'npm', available: true, installed: true },
      { name: 'pnpm', available: true, installed: false },
      { name: 'yarn', available: false, installed: false },
      { name: 'bun', available: true, installed: true },
    ],
    brew: { available: true, installed: true },
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath:
        '/Users/x/.nvm/versions/node/v24/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(calls.uninstall).toEqual(['npm', 'bun']);
  expect(calls.uninstallBrew).toBe(1);
  expect(output.lines.some((l) => l.msg === 'removed via npm')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'not installed via pnpm')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'yarn not available — skipped')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'removed via bun')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'removed via brew')).toBe(true);
});

test('sweep: warns and continues when one PM uninstall reports failure', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    detections: [
      { name: 'npm', available: true, installed: true },
      { name: 'pnpm', available: false, installed: false },
      { name: 'yarn', available: false, installed: false },
      { name: 'bun', available: true, installed: true },
    ],
    uninstallResult: (n) =>
      n === 'npm'
        ? { ok: false, message: 'npm uninstall failed: EACCES' }
        : { ok: true, message: `removed via ${n}` },
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/Users/x/.nvm/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg === 'npm uninstall failed: EACCES'),
  ).toBe(true);
  expect(output.lines.some((l) => l.msg === 'removed via bun')).toBe(true);
});

test('sweep: catches throws inside individual uninstall and continues', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    detections: [
      { name: 'npm', available: true, installed: true },
      { name: 'pnpm', available: false, installed: false },
      { name: 'yarn', available: false, installed: false },
      { name: 'bun', available: true, installed: true },
    ],
    uninstallThrows: 'npm',
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/Users/x/.nvm/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg.includes('npm uninstall threw')),
  ).toBe(true);
  expect(output.lines.some((l) => l.msg === 'removed via bun')).toBe(true);
});

test('sweep: warns when detectAll throws but still proceeds to brew', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    detectAllThrows: true,
    brew: { available: true, installed: true },
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) => l.level === 'warn' && l.msg.includes('package-manager detection failed'),
    ),
  ).toBe(true);
  expect(output.lines.some((l) => l.msg === 'removed via brew')).toBe(true);
});

test('sweep: warns when detectBrew throws and continues', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    detections: [
      { name: 'npm', available: false, installed: false },
      { name: 'pnpm', available: false, installed: false },
      { name: 'yarn', available: false, installed: false },
      { name: 'bun', available: false, installed: false },
    ],
    detectBrewThrows: true,
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg.includes('brew detection failed')),
  ).toBe(true);
});

test('sweep: warns when uninstallBrew throws', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    brew: { available: true, installed: true },
    uninstallBrewThrows: true,
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg.includes('brew uninstall threw')),
  ).toBe(true);
});

test('sweep: warns on uninstallBrew failure result', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({
    brew: { available: true, installed: true },
    uninstallBrewResult: { ok: false, message: 'brew uninstall failed: locked' },
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/Users/x/.nvm/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg === 'brew uninstall failed: locked'),
  ).toBe(true);
});

test('sweep: brew not available — skipped', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({ brew: { available: false, installed: false } });
  const { sm } = fakeManager();
  const output = captureOutput();
  await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/Users/x/.nvm/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(output.lines.some((l) => l.msg === 'brew not available — skipped')).toBe(true);
});

test('sweep: brew available but not installed', async () => {
  await writeConfig('npm');
  const { sweep } = fakeSweep({ brew: { available: true, installed: false } });
  const { sm } = fakeManager();
  const output = captureOutput();
  await runUninstall(
    {
      ...depsFor(sm),
      output,
      sweep,
      currentExecPath: '/Users/x/.nvm/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(output.lines.some((l) => l.msg === 'not installed via brew')).toBe(true);
});

test('binary remover: invoked when execPath is a direct binary; installDir forwarded', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const { remover, calls } = fakeRemover({
    ok: true,
    deferred: false,
    message: 'removed /usr/local/bin/proxai-gateway',
  });
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      binaryRemover: remover,
      installDir: '/Users/x/.proxai/bin',
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(calls.remove).toEqual([
    {
      execPath: '/usr/local/bin/proxai-gateway',
      options: { installDir: '/Users/x/.proxai/bin' },
    },
  ]);
  expect(output.lines.some((l) => l.msg === 'removed /usr/local/bin/proxai-gateway')).toBe(true);
});

test('binary remover: NOT invoked when execPath is under node_modules (PM-managed)', async () => {
  await writeConfig('npm');
  const { sm } = fakeManager();
  const { remover, calls } = fakeRemover();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      binaryRemover: remover,
      currentExecPath:
        '/Users/x/.nvm/versions/node/v24/lib/node_modules/@proxai/gateway/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(calls.remove).toHaveLength(0);
});

test('binary remover: deferred result still printed as info', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const { remover } = fakeRemover({
    ok: true,
    deferred: true,
    message: 'scheduled removal of C:\\bin\\proxai.exe on exit',
  });
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      binaryRemover: remover,
      currentExecPath: 'C:\\bin\\proxai.exe',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) => l.level === 'info' && l.msg === 'scheduled removal of C:\\bin\\proxai.exe on exit',
    ),
  ).toBe(true);
});

test('binary remover: failure result is surfaced as a warn', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const { remover } = fakeRemover({
    ok: false,
    deferred: false,
    message: 'failed to remove binary at /usr/local/bin/proxai-gateway: EACCES',
  });
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      binaryRemover: remover,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) =>
        l.level === 'warn' &&
        l.msg === 'failed to remove binary at /usr/local/bin/proxai-gateway: EACCES',
    ),
  ).toBe(true);
});

test('binary remover: omitted → fallback hint printed for direct binaries', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some(
      (l) => l.msg === 'to remove the binary itself, run: rm /usr/local/bin/proxai-gateway',
    ),
  ).toBe(true);
});

test('binary remover: defaults currentExecPath to process.execPath when not provided', async () => {
  await writeConfig('npm');
  const { sm } = fakeManager();
  const { remover } = fakeRemover();
  const output = captureOutput();
  const result = await runUninstall(
    { ...depsFor(sm), output, binaryRemover: remover },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
});

test('binary remover: omits installDir option when installDir is absent', async () => {
  await writeConfig('github_release');
  const { sm } = fakeManager();
  const { remover, calls } = fakeRemover();
  const output = captureOutput();
  await runUninstall(
    {
      ...depsFor(sm),
      output,
      binaryRemover: remover,
      currentExecPath: '/usr/local/bin/proxai-gateway',
    },
    { yes: true },
  );
  expect(calls.remove).toEqual([{ execPath: '/usr/local/bin/proxai-gateway', options: undefined }]);
});

test('path cleaner: invoked with installDir; outcomes printed', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const { cleaner, calls } = fakeCleaner([
    { path: '/h/.zshrc', cleaned: true, reason: 'removed installer PATH block' },
    { path: '/h/.bashrc', cleaned: false, reason: 'no installer marker found' },
  ]);
  const output = captureOutput();
  await runUninstall(
    {
      ...depsFor(sm),
      output,
      pathCleaner: cleaner,
      installDir: '/h/.proxai/bin',
    },
    { yes: true },
  );
  expect(calls.clean).toEqual(['/h/.proxai/bin']);
  expect(
    output.lines.some(
      (l) => l.level === 'info' && l.msg === '/h/.zshrc: removed installer PATH block',
    ),
  ).toBe(true);
  expect(
    output.lines.some(
      (l) => l.level === 'info' && l.msg === '/h/.bashrc: no installer marker found',
    ),
  ).toBe(true);
});

test('path cleaner: throws → warn printed, exit still 0', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const { cleaner } = fakeCleaner(async () => {
    throw new Error('rc-write-EROFS');
  });
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      pathCleaner: cleaner,
      installDir: '/h/.proxai/bin',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(
    output.lines.some((l) => l.level === 'warn' && l.msg === 'PATH cleanup failed: rc-write-EROFS'),
  ).toBe(true);
});

test('path cleaner: skipped when pathCleaner is missing', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      installDir: '/h/.proxai/bin',
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
});

test('path cleaner: skipped when installDir is missing even if cleaner provided', async () => {
  await writeConfig();
  const { sm } = fakeManager();
  const { cleaner, calls } = fakeCleaner();
  const output = captureOutput();
  await runUninstall(
    {
      ...depsFor(sm),
      output,
      pathCleaner: cleaner,
    },
    { yes: true },
  );
  expect(calls.clean).toHaveLength(0);
});

test('buildConfirmationMessage renders the same notice box at different terminal widths', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 50,
      configurable: true,
    });
    const msg50 = buildConfirmationMessage();
    expect(msg50).toContain('WARNING');
    expect(msg50).toContain('IMPORTANT NOTICE');
    expect(msg50).toContain('RECOMMENDED ALTERNATIVE');

    Object.defineProperty(process.stdout, 'columns', {
      value: 120,
      configurable: true,
    });
    const msg120 = buildConfirmationMessage();
    expect(msg120).toContain('IMPORTANT NOTICE');
    expect(msg120).toContain('RECOMMENDED ALTERNATIVE');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('silent output in regular user flow (isDevMode: false)', async () => {
  await writeConfig('github_release');
  await writeFile(serviceUnitPath, '<plist/>');
  const sm = fakeManager().sm;
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(sm),
      output,
      isDevMode: false,
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(output.lines).toHaveLength(1);
  expect(output.lines[0]?.level).toBe('success');
  expect(output.lines[0]?.msg).toBe('uninstalled');
});

test('handles devServiceManager stop, unregister and dev unit-file cleanup', async () => {
  await writeConfig('github_release');
  const devUnitPath = join(tmpRoot, 'dev_unit.plist');
  await writeFile(devUnitPath, '<plist/>');

  const { sm: devSm, calls: devCalls } = fakeManager();
  const { sm: prodSm } = fakeManager();
  const output = captureOutput();
  const result = await runUninstall(
    {
      ...depsFor(prodSm),
      output,
      devServiceManager: devSm,
      devServiceUnitPath: devUnitPath,
    },
    { yes: true },
  );

  expect(result.exitCode).toBe(0);
  expect(devCalls.stop).toBe(1);
  expect(devCalls.unregister).toBe(1);
  expect(await Bun.file(devUnitPath).exists()).toBe(false);
});

test('sentinel reading for isDevMode resolves based on DEV_MODE file', async () => {
  const { sm } = fakeManager();
  // Inject readBootId so the DEV_MODE sentinel match is deterministic — the real
  // one throws on CI Linux (empty /proc boot_id) and is slow on Windows.
  const bootId = 'test-boot-id-uninstall';
  const readBootId = (): Promise<string> => Promise.resolve(bootId);

  // 1. DEV_MODE sentinel exists -> isDevMode is true
  await writeFile(join(tmpRoot, '.proxai', 'DEV_MODE'), JSON.stringify({ bootId }));
  const depsWithDevSentinel = { ...depsFor(sm), readBootId };
  delete (depsWithDevSentinel as { isDevMode?: unknown }).isDevMode; // force sentinel read
  const output1 = captureOutput();
  await runUninstall({ ...depsWithDevSentinel, output: output1 }, { yes: true });
  expect(output1.lines.some((l) => l.msg === 'daemon stopped')).toBe(true);

  // 2. DEV_MODE sentinel does not exist -> isDevMode is false (silent output except final success)
  await rm(join(tmpRoot, '.proxai', 'DEV_MODE'), { force: true });
  const depsNoSentinel = { ...depsFor(sm), readBootId };
  delete (depsNoSentinel as { isDevMode?: unknown }).isDevMode; // force sentinel read
  const output2 = captureOutput();
  await runUninstall({ ...depsNoSentinel, output: output2 }, { yes: true });
  expect(output2.lines.some((l) => l.msg === 'daemon stopped')).toBe(false);
});

test('idempotent non-dev: prints "uninstalled" when nothing exists and reset is false', async () => {
  const { sm } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall({ ...depsFor(sm), output, isDevMode: false }, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled')).toBe(true);
  expect(output.lines.some((l) => l.msg === 'no installation found')).toBe(false);
});

test('idempotent non-dev: prints "uninstalled and reset" when nothing exists and reset is true', async () => {
  const { sm } = fakeManager({ registered: false });
  const output = captureOutput();
  const result = await runUninstall(
    { ...depsFor(sm), output, isDevMode: false },
    { reset: true, yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(output.lines.some((l) => l.level === 'success' && l.msg === 'uninstalled and reset')).toBe(
    true,
  );
  expect(output.lines.some((l) => l.msg === 'no installation found')).toBe(false);
});
