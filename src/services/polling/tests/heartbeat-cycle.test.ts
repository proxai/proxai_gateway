import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMetadata, METADATA_KEYS, openInMemoryBufferDb, setMetadata } from 'services/buffer';

import { runHeartbeatCycle, shouldRunAutoUpgrade, writeAuthFailedSentinel } from 'services/polling';
import type { HeartbeatCycleContext } from 'services/polling';
import type { CoordinatedUpgradeDeps } from 'services/upgrade/coordinated-upgrade.ts';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-heartbeat-cycle-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function makeContext(overrides: Partial<HeartbeatCycleContext> = {}): HeartbeatCycleContext {
  const base: HeartbeatCycleContext = {
    buffer,
    gatewayVersion: 'gw-0.1',
    installedAt: new Date().toISOString(),
    staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
  };
  return { ...base, ...overrides };
}

function fakeFetchOk(latestVersion: string, hasUpdate = false): FetchFn {
  return async () => {
    const tag = hasUpdate ? `v${latestVersion}` : `v${latestVersion}`;
    const body = JSON.stringify({
      tag_name: tag,
      assets: [
        {
          name: `proxai-gateway-${process.platform}-${process.arch}`,
          browser_download_url: 'https://example.com/asset',
        },
      ],
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function fakeFetchStatus(status: number): FetchFn {
  return async () => new Response(null, { status });
}

test('AUTH_FAILED does NOT gate heartbeat — auto-upgrade still runs', async () => {
  await writeAuthFailedSentinel(join(dir, 'AUTH_FAILED'), 'halt');
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: fakeFetchOk('2.0.0'),
  });
  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(true);
});

test('shouldRunAutoUpgrade: brew install requires sentinel path', () => {
  const ctxNo = makeContext({ installSource: 'brew' });
  const ctxYes = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
  });
  expect(shouldRunAutoUpgrade(ctxNo)).toBe(false);
  expect(shouldRunAutoUpgrade(ctxYes)).toBe(true);
});

test('shouldRunAutoUpgrade: non-brew requires binaryPath + currentVersion', () => {
  const ctxNo = makeContext({ installSource: 'npm' });
  const ctxYes = makeContext({
    installSource: 'npm',
    binaryPath: '/tmp/bin',
    currentVersion: '1.0.0',
  });
  expect(shouldRunAutoUpgrade(ctxNo)).toBe(false);
  expect(shouldRunAutoUpgrade(ctxYes)).toBe(true);
});

test('brew: writes UPDATE_AVAILABLE sentinel when newer version exists', async () => {
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: fakeFetchOk('2.0.0'),
  });
  await runHeartbeatCycle(ctx);
  expect(await Bun.file(join(dir, 'UPDATE_AVAILABLE')).exists()).toBe(true);
  expect(getMetadata(buffer, METADATA_KEYS.lastVersionCheckAt)).not.toBeNull();
  expect(getMetadata(buffer, METADATA_KEYS.latestKnownVersion)).toBe('2.0.0');
});

test('brew: clears UPDATE_AVAILABLE sentinel when up to date', async () => {
  await Bun.write(
    join(dir, 'UPDATE_AVAILABLE'),
    JSON.stringify({ latest_version: '0.0.1', current_version: '0.0.1', detected_at: 'x' }),
  );
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '99.99.99',
    versionCheckFetch: fakeFetchOk('1.0.0'),
  });
  await runHeartbeatCycle(ctx);
  expect(await Bun.file(join(dir, 'UPDATE_AVAILABLE')).exists()).toBe(false);
});

test('version check fires once per interval, skips inside the window', async () => {
  setMetadata(buffer, METADATA_KEYS.lastVersionCheckAt, new Date().toISOString());
  let calls = 0;
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: async () => {
      calls++;
      return new Response(JSON.stringify({ tag_name: 'v1.0.0', assets: [] }), { status: 200 });
    },
    versionCheckIntervalMs: 60_000,
  });
  await runHeartbeatCycle(ctx);
  expect(calls).toBe(0);
});

test('brew: 503 logs warn version_check.unavailable', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: fakeFetchStatus(503),
    logger: fakeLogger,
  });
  await runHeartbeatCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('version check failed'))).toBe(
    true,
  );
});

test('brew: 404 (no releases) is silent at warn level', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: fakeFetchStatus(404),
    logger: fakeLogger,
  });
  await runHeartbeatCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('version check failed'))).toBe(
    false,
  );
});

test('brew with no sentinel path is a no-op', async () => {
  const ctx = makeContext({
    installSource: 'brew',
    currentVersion: '0.0.1',
  });
  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(false);
});

test('brew: falls back to gatewayVersion when currentVersion is omitted', async () => {
  let capturedVersion = '';
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    versionCheckFetch: async () => {
      capturedVersion = 'see-tag';
      return new Response(JSON.stringify({ tag_name: 'vgw-0.1', assets: [] }), { status: 200 });
    },
  });
  await runHeartbeatCycle(ctx);
  expect(capturedVersion).toBe('see-tag');
});

test('non-brew: skipped when binaryPath is missing', async () => {
  const ctx = makeContext({ installSource: 'npm', currentVersion: '1.0.0' });
  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(false);
});

test('non-brew: skipped when currentVersion is missing', async () => {
  const ctx = makeContext({ installSource: 'npm', binaryPath: '/tmp/bin' });
  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(false);
});

test('non-brew: runs auto-upgrade and writes lastVersionCheckAt', async () => {
  let downloadCalled = false;
  const ctx = makeContext({
    installSource: 'npm',
    binaryPath: '/tmp/proxai-bin-noop',
    currentVersion: '0.0.1',
    versionCheckFetch: async (_url: unknown) => {
      downloadCalled = true;
      const platform = process.platform;
      const arch = process.arch;
      const ext = platform === 'win32' ? '.exe' : '';
      return new Response(
        JSON.stringify({
          tag_name: 'v0.0.1',
          assets: [
            {
              name: `proxai-gateway-${platform}-${arch}${ext}`,
              browser_download_url: 'https://example.com/asset',
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(true);
  expect(downloadCalled).toBe(true);
  expect(getMetadata(buffer, METADATA_KEYS.lastVersionCheckAt)).not.toBeNull();
});

test('catch wrapping auto-upgrade swallows thrown errors via logger.warn', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: fakeFetchOk('0.0.1'),
    logger: fakeLogger,
  });
  buffer.exec('DROP TABLE buffer_metadata');
  await runHeartbeatCycle(ctx);
  expect(
    entries.some(
      (e) =>
        e.level === 'warn' &&
        (e.msg.includes('version check failed') || e.msg.includes('continuing heartbeat')),
    ),
  ).toBe(true);
});

test('logs warn when version check throws', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext({
    installSource: 'brew',
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    currentVersion: '0.0.1',
    versionCheckFetch: async () => {
      throw new Error('boom');
    },
    logger: fakeLogger,
  });
  await runHeartbeatCycle(ctx);
  expect(
    entries.some(
      (e) =>
        e.level === 'warn' &&
        (e.msg.includes('version check failed') || e.msg.includes('version_check.failed')),
    ),
  ).toBe(true);
});

interface FakeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => FakeLogger;
}

function makeFakeLogger(entries: { level: string; msg: string }[]): FakeLogger {
  function record(level: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const last = args[args.length - 1];
      const msg = typeof last === 'string' ? last : JSON.stringify(last);
      entries.push({ level, msg });
    };
  }
  const logger: FakeLogger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => logger,
  };
  return logger;
}

test('non-brew: runs coordinated upgrade and exits when applied', async () => {
  let exitCalled = false;

  const ctx = makeContext({
    installSource: 'npm',
    binaryPath: '/tmp/proxai-bin-noop',
    currentVersion: '0.0.1',
    devMode: false,
    coordinatedUpgradeDeps: {} as unknown as CoordinatedUpgradeDeps,
    coordinatedUpgradeFn: async () => ({ upgradeApplied: true }),
    exitProcess: () => {
      exitCalled = true;
    },
  });

  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(true);
  expect(exitCalled).toBe(true);
});

test('non-brew: runs coordinated upgrade and does not exit when not applied', async () => {
  let exitCalled = false;

  const ctx = makeContext({
    installSource: 'npm',
    binaryPath: '/tmp/proxai-bin-noop',
    currentVersion: '0.0.1',
    devMode: false,
    coordinatedUpgradeDeps: {} as unknown as CoordinatedUpgradeDeps,
    coordinatedUpgradeFn: async () => ({ upgradeApplied: false }),
    exitProcess: () => {
      exitCalled = true;
    },
  });

  const result = await runHeartbeatCycle(ctx);
  expect(result.ranAutoUpgrade).toBe(true);
  expect(exitCalled).toBe(false);
});
