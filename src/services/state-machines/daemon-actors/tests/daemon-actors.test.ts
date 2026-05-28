import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInMemoryBufferDb, getMachineSnapshots } from 'services/buffer';
import type { Database } from 'bun:sqlite';
import { startDaemonActors } from 'services/state-machines/daemon-actors';
import type { SentinelWatcherPaths } from 'services/state-machines/sentinel-watcher';
import type { MinimalLogger } from 'core/log';

let dir: string;
let paths: SentinelWatcherPaths;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-daemon-actors-'));
  paths = {
    configDir: dir,
    authFailed: join(dir, 'AUTH_FAILED'),
    bufferFull: join(dir, 'BUFFER_FULL'),
    sessionStopped: join(dir, 'SESSION_STOPPED'),
    updateAvailable: join(dir, 'UPDATE_AVAILABLE'),
  };
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('startDaemonActors boots a registry actor in absent state for every sentinel', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  const snapshot = handle.registry.getSnapshot();
  expect(snapshot.matches({ auth: 'absent' })).toBe(true);
  expect(snapshot.matches({ bufferPressure: 'ok' })).toBe(true);
  await handle.stop();
});

test('startDaemonActors reflects pre-existing AUTH_FAILED file via initial sentinel sweep', async () => {
  await writeFile(paths.authFailed, '{"reason":"halt","detected_at":"x"}');
  const handle = await startDaemonActors({ buffer, paths });
  expect(handle.registry.getSnapshot().matches({ auth: 'present' })).toBe(true);
  await handle.stop();
});

test('daemon-root actor advances through boot to running when markReady is called', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  handle.markReady('2026-05-26T12:00:00.000Z');
  const snapshot = handle.root.getSnapshot();
  expect(snapshot.value).toBe('running');
  expect(snapshot.context.bootedAtUtc).toBe('2026-05-26T12:00:00.000Z');
  await handle.stop();
});

test('requestShutdown moves daemon-root to draining_for_shutdown with the given reason', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  handle.markReady('2026-05-26T12:00:00.000Z');
  handle.requestShutdown('sigterm');
  expect(handle.root.getSnapshot().value).toBe('draining_for_shutdown');
  expect(handle.root.getSnapshot().context.shutdownReason).toBe('sigterm');
  await handle.stop();
});

test('markExited records exitedAtUtc and reaches the exited terminal', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  handle.markReady('2026-05-26T12:00:00.000Z');
  handle.requestShutdown('upgrade');
  handle.markExited('2026-05-26T12:05:00.000Z');
  expect(handle.root.getSnapshot().value).toBe('exited');
  expect(handle.root.getSnapshot().context.exitedAtUtc).toBe('2026-05-26T12:05:00.000Z');
  await handle.stop();
});

test('flushSnapshots writes a JSON blob into daemon_state.machine_snapshots', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  handle.flushSnapshots();
  const raw = getMachineSnapshots(buffer);
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
  expect(parsed['sentinel-registry']).toBeDefined();
  expect(parsed['daemon-root']).toBeDefined();
  await handle.stop();
});

test('stop() releases the sentinel watcher and snapshot timer without throwing', async () => {
  const handle = await startDaemonActors({ buffer, paths, snapshotIntervalMs: 50 });
  await sleep(80);
  await handle.stop();
  expect(true).toBe(true);
});

test('writing a sentinel file after boot updates the registry via fs.watch', async () => {
  const handle = await startDaemonActors({ buffer, paths });
  expect(handle.registry.getSnapshot().matches({ auth: 'absent' })).toBe(true);
  await writeFile(paths.authFailed, '{"reason":"halt","detected_at":"x"}');
  await waitUntilTrue(() => handle.registry.getSnapshot().matches({ auth: 'present' }));
  expect(handle.registry.getSnapshot().matches({ auth: 'present' })).toBe(true);
  await handle.stop();
});

test('startDaemonActors initializes stately inspector when DEV_MODE is active and xstateInspect is true', async () => {
  await writeFile(join(paths.configDir, 'DEV_MODE'), '');

  let inspectCalled = false;
  await mock.module('@statelyai/inspect', () => {
    return {
      createBrowserInspector: () => {
        return {
          inspect: () => {
            inspectCalled = true;
          },
        };
      },
    };
  });

  const handle = await startDaemonActors({
    buffer,
    paths,
    xstateInspect: true,
  });

  expect(inspectCalled).toBe(true);
  await handle.stop();
  mock.restore();
});

test('startDaemonActors logs a warning when stately inspector initialization throws', async () => {
  await writeFile(join(paths.configDir, 'DEV_MODE'), '');

  await mock.module('@statelyai/inspect', () => {
    return {
      createBrowserInspector: () => {
        throw new Error('inspect failed mock');
      },
    };
  });

  const warnings: { ctx: unknown; msg: string }[] = [];
  const logger: MinimalLogger = {
    warn: (ctx: unknown, msg: string) => {
      warnings.push({ ctx, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  };

  const handle = await startDaemonActors({
    buffer,
    paths,
    xstateInspect: true,
    logger,
  });

  expect(warnings.length).toBe(1);
  const warn = warnings[0];
  if (!warn) {
    throw new Error('Expected warning to be logged');
  }
  expect(warn.msg).toBe('failed to initialize stately browser inspector');
  expect(JSON.stringify(warn.ctx)).toContain('inspect failed mock');

  await handle.stop();
  mock.restore();
});

test('flushSnapshots logs a warning when database is closed', async () => {
  const warnings: { ctx: unknown; msg: string }[] = [];
  const logger: MinimalLogger = {
    warn: (ctx: unknown, msg: string) => {
      warnings.push({ ctx, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  };

  const handle = await startDaemonActors({
    buffer,
    paths,
    logger,
  });

  buffer.close();

  handle.flushSnapshots();

  expect(warnings.length).toBe(1);
  const warn = warnings[0];
  if (!warn) {
    throw new Error('Expected warning to be logged');
  }
  expect(warn.msg).toBe('failed to persist machine snapshots');

  buffer = openInMemoryBufferDb();

  await handle.stop();
});

async function waitUntilTrue(check: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const step = async (): Promise<void> => {
    if (check() || Date.now() >= deadline) return;
    await sleep(stepMs);
    return step();
  };
  return step();
}
