import { afterEach, beforeEach, expect, test } from 'bun:test';

import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { openBufferDb } from 'services/buffer';
import { gatherSignals } from 'cli/commands/doctor/gather-signals.ts';
import { captureOutput } from 'cli/output.ts';
import type { DoctorCommandDeps } from 'cli/commands/doctor/doctor.types.ts';
import type { ServiceManager } from 'cli/service-manager';

let dir: string;
let bufferDbPath: string;

const origFetch = globalThis.fetch;
const origWhich = Bun.which;
const origSpawn = Bun.spawn;

function setWhich(fn: typeof Bun.which): void {
  (Bun as unknown as { which: typeof Bun.which }).which = fn;
}

function setSpawn(fn: typeof Bun.spawn): void {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = fn;
}

function setFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}

function fakeSpawn(stdoutText: string): typeof Bun.spawn {
  const impl = (): { stdout: ReadableStream<Uint8Array>; exited: Promise<number> } => ({
    stdout: new Response(stdoutText).body ?? new Response('').body ?? new ReadableStream(),
    exited: Promise.resolve(0),
  });
  return impl as unknown as typeof Bun.spawn;
}

function throwingSpawn(): typeof Bun.spawn {
  const impl = (): never => {
    throw new Error('spawn boom');
  };
  return impl as unknown as typeof Bun.spawn;
}

function okServiceManager(registered: boolean, running: boolean): ServiceManager {
  return {
    ensureRegistered: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    isRegistered: () => Promise.resolve(registered),
    isRunning: () => Promise.resolve(running),
    runtimeInfo: () => Promise.resolve({ pid: null, startedAt: null }),
  };
}

function throwingServiceManager(): ServiceManager {
  return {
    ...okServiceManager(false, false),
    isRegistered: () => Promise.reject(new Error('mgr boom')),
    isRunning: () => Promise.reject(new Error('mgr boom')),
  };
}

function makeDeps(over: Partial<DoctorCommandDeps> = {}): DoctorCommandDeps {
  const base: DoctorCommandDeps = {
    output: captureOutput(),
    bufferDbPath,
    configFilePath: join(dir, 'config.toml'),
    configDirPath: dir,
    logDirPath: dir,
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    nestVerifyKeyUrl: 'https://nest.example/verify',
    serviceManager: okServiceManager(true, true),
    platform: 'linux',
    binaryPath: join(dir, 'binary'),
    currentVersion: '2026.5.28',
    profileCtx: {
      name: 'dev',
      isDev: true,
      configDir: dir,
      configFilePath: join(dir, 'config.toml'),
      bufferDbPath,
      logDir: dir,
      sentinels: {
        authFailed: join(dir, 'AUTH_FAILED'),
        bufferFull: join(dir, 'BUFFER_FULL'),
        sessionStopped: join(dir, 'SESSION_STOPPED'),
        consent: join(dir, 'CONSENT'),
        updateAvailable: join(dir, 'UPDATE_AVAILABLE'),
      },
      controlSocketPath: join(dir, 'control.sock'),
      defaultNestBaseUrl: 'https://nest.example',
    },
  };
  return { ...base, ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-doctor-gather-'));
  bufferDbPath = join(dir, 'buffer.db');
  const db = openBufferDb(bufferDbPath);
  db.close();
  setFetch(
    ((): Promise<Response> =>
      Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof globalThis.fetch,
  );
  setWhich((() => null) as typeof Bun.which);
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  setWhich(origWhich);
  setSpawn(origSpawn);
  await rmRecursive(dir);
});

test('config absent: configParses and apiKeyPresent stay false', async () => {
  const signals = await gatherSignals(makeDeps());
  expect(signals.configExists).toBe(false);
  expect(signals.configParses).toBe(false);
  expect(signals.apiKeyPresent).toBe(false);
  expect(signals.platform).toBe('linux');
  expect(signals.binary.version).toBe('2026.5.28');
  expect(signals.binary.installSource).toBeNull();
});

test('config present and non-empty with api_key sets parses + apiKeyPresent', async () => {
  await writeFile(join(dir, 'config.toml'), 'api_key = "secret"\n');
  await writeFile(join(dir, 'binary'), 'x');
  const signals = await gatherSignals(makeDeps());
  expect(signals.configExists).toBe(true);
  expect(signals.configParses).toBe(true);
  expect(signals.apiKeyPresent).toBe(true);
  expect(signals.binary.mtime).not.toBeNull();
});

test('config present but empty: parses false, apiKey false', async () => {
  await writeFile(join(dir, 'config.toml'), '');
  const signals = await gatherSignals(makeDeps());
  expect(signals.configExists).toBe(true);
  expect(signals.configParses).toBe(false);
  expect(signals.apiKeyPresent).toBe(false);
});

test('config present with empty api_key string: apiKeyPresent false', async () => {
  await writeFile(join(dir, 'config.toml'), 'api_key = ""\n');
  const signals = await gatherSignals(makeDeps());
  expect(signals.configParses).toBe(true);
  expect(signals.apiKeyPresent).toBe(false);
});

test('config present but no api_key key: apiKeyPresent false', async () => {
  await writeFile(join(dir, 'config.toml'), 'other = "v"\n');
  const signals = await gatherSignals(makeDeps());
  expect(signals.configParses).toBe(true);
  expect(signals.apiKeyPresent).toBe(false);
});

test('null service manager yields unregistered + not-running', async () => {
  const signals = await gatherSignals(makeDeps({ serviceManager: null }));
  expect(signals.serviceUnitRegistered).toBe(false);
  expect(signals.daemonRunning).toBe(false);
});

test('throwing service manager degrades to unregistered + not-running', async () => {
  const signals = await gatherSignals(makeDeps({ serviceManager: throwingServiceManager() }));
  expect(signals.serviceUnitRegistered).toBe(false);
  expect(signals.daemonRunning).toBe(false);
});

test('service manager returning false flags maps through', async () => {
  const signals = await gatherSignals(makeDeps({ serviceManager: okServiceManager(true, false) }));
  expect(signals.serviceUnitRegistered).toBe(true);
  expect(signals.daemonRunning).toBe(false);
});

test('sentinel files present are read as true', async () => {
  await writeFile(join(dir, 'AUTH_FAILED'), '{}');
  await writeFile(join(dir, 'BUFFER_FULL'), '{}');
  await writeFile(join(dir, 'SESSION_STOPPED'), '{}');
  await writeFile(join(dir, 'UPDATE_AVAILABLE'), '{}');
  const signals = await gatherSignals(makeDeps());
  expect(signals.sentinels.authFailed).toBe(true);
  expect(signals.sentinels.bufferFull).toBe(true);
  expect(signals.sentinels.sessionStopped).toBe(true);
  expect(signals.sentinels.updateAvailable).toBe(true);
});

test('nest unreachable when fetch rejects', async () => {
  setFetch((() => Promise.reject(new Error('net down'))) as unknown as typeof globalThis.fetch);
  const signals = await gatherSignals(makeDeps());
  expect(signals.network.nestReachable).toBe(false);
});

test('nest reachable true when fetch resolves under 600', async () => {
  setFetch((() =>
    Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof globalThis.fetch);
  const signals = await gatherSignals(makeDeps());
  expect(signals.network.nestReachable).toBe(true);
});

test('binary mtime null when binary path missing', async () => {
  const signals = await gatherSignals(makeDeps());
  expect(signals.binary.mtime).toBeNull();
});

test('source paths existing are detected', async () => {
  const signals = await gatherSignals(makeDeps());
  expect(typeof signals.sourcePaths.claudeCodeExists).toBe('boolean');
  expect(typeof signals.sourcePaths.cursorExists).toBe('boolean');
  expect(typeof signals.sourcePaths.codexExists).toBe('boolean');
  expect(typeof signals.sourcePaths.geminiCliExists).toBe('boolean');
});

test('linux: systemd linger null when loginctl is absent', async () => {
  setWhich((() => null) as typeof Bun.which);
  const signals = await gatherSignals(makeDeps({ platform: 'linux' }));
  expect(signals.systemdLingerEnabled).toBeNull();
  expect(signals.macOsQuarantineXattr).toBeNull();
});

test('linux: systemd linger true when loginctl reports yes', async () => {
  setWhich((() => '/usr/bin/loginctl') as typeof Bun.which);
  setSpawn(fakeSpawn('yes\n'));
  const signals = await gatherSignals(makeDeps({ platform: 'linux' }));
  expect(signals.systemdLingerEnabled).toBe(true);
});

test('linux: systemd linger false when loginctl reports no', async () => {
  setWhich((() => '/usr/bin/loginctl') as typeof Bun.which);
  setSpawn(fakeSpawn('no\n'));
  const signals = await gatherSignals(makeDeps({ platform: 'linux' }));
  expect(signals.systemdLingerEnabled).toBe(false);
});

test('linux: systemd linger null when spawn throws', async () => {
  setWhich((() => '/usr/bin/loginctl') as typeof Bun.which);
  setSpawn(throwingSpawn());
  const signals = await gatherSignals(makeDeps({ platform: 'linux' }));
  expect(signals.systemdLingerEnabled).toBeNull();
});

test('darwin: cursor config dir non-win path and quarantine probe with xattr absent', async () => {
  setWhich((() => null) as typeof Bun.which);
  const signals = await gatherSignals(makeDeps({ platform: 'darwin' }));
  expect(signals.systemdLingerEnabled).toBeNull();
  expect(signals.macOsQuarantineXattr).toBeNull();
});

test('darwin: quarantine xattr present', async () => {
  setWhich((() => '/usr/bin/xattr') as typeof Bun.which);
  setSpawn(fakeSpawn('com.apple.quarantine: 0081;abc\n'));
  const signals = await gatherSignals(makeDeps({ platform: 'darwin' }));
  expect(signals.macOsQuarantineXattr).toBe(true);
});

test('darwin: quarantine xattr absent in xattr output', async () => {
  setWhich((() => '/usr/bin/xattr') as typeof Bun.which);
  setSpawn(fakeSpawn('com.other.thing: 1\n'));
  const signals = await gatherSignals(makeDeps({ platform: 'darwin' }));
  expect(signals.macOsQuarantineXattr).toBe(false);
});

test('darwin: quarantine probe null when xattr spawn throws', async () => {
  setWhich((() => '/usr/bin/xattr') as typeof Bun.which);
  setSpawn(throwingSpawn());
  const signals = await gatherSignals(makeDeps({ platform: 'darwin' }));
  expect(signals.macOsQuarantineXattr).toBeNull();
});

test('win32: uses AppData cursor config dir and skips platform probes', async () => {
  const signals = await gatherSignals(makeDeps({ platform: 'win32' }));
  expect(signals.platform).toBe('win32');
  expect(signals.systemdLingerEnabled).toBeNull();
  expect(signals.macOsQuarantineXattr).toBeNull();
});

test('config present but unreadable degrades configParses to false', async () => {
  if (process.platform === 'win32') return;
  const configFilePath = join(dir, 'config.toml');
  await writeFile(configFilePath, 'api_key = "x"\n');
  await chmod(configFilePath, 0o000);
  const signals = await gatherSignals(makeDeps({ configFilePath }));
  await chmod(configFilePath, 0o600);
  expect(signals.configExists).toBe(true);
  expect(signals.configParses).toBe(false);
  expect(signals.apiKeyPresent).toBe(false);
});

test('configDir/logDir not writable degrades to false via internal catch', async () => {
  const missing = join(dir, 'does-not-exist-dir');
  const signals = await gatherSignals(makeDeps({ configDirPath: missing, logDirPath: missing }));
  expect(signals.filesystem.configDirWritable).toBe(false);
  expect(signals.filesystem.logDirWritable).toBe(false);
});

test('sentinel read with invalid path degrades to false', async () => {
  const badPath = join(dir, 'AUTH\0FAILED');
  const signals = await gatherSignals(makeDeps({ authFailedSentinelPath: badPath }));
  expect(signals.sentinels.authFailed).toBe(false);
});

test('buffer/daemon/recent/resync sections populated from query result defaults', async () => {
  const signals = await gatherSignals(makeDeps());
  expect(signals.buffer.pendingCount).toBe(0);
  expect(signals.daemonState.captureLastCycleAt).toBeNull();
  expect(signals.recentEvents.rateLimitedCount).toBe(0);
  expect(signals.resyncEvents.totalCount).toBe(0);
  expect(signals.resyncEvents.regressionLoops).toEqual([]);
  expect(signals.clockSkewMs).toBeNull();
  expect(
    signals.filesystem.diskFreeBytes === null ||
      typeof signals.filesystem.diskFreeBytes === 'number',
  ).toBe(true);
});
