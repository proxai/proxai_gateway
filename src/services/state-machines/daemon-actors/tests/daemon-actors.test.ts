import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInMemoryBufferDb, getMachineSnapshots } from 'services/buffer';
import type { Database } from 'bun:sqlite';
import { startDaemonActors } from 'services/state-machines/daemon-actors';
import type { SentinelWatcherPaths } from 'services/state-machines/sentinel-watcher';

let dir: string;
let paths: SentinelWatcherPaths;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-daemon-actors-'));
  paths = {
    configDir: dir,
    authFailed: join(dir, 'AUTH_FAILED'),
    paused: join(dir, 'PAUSED'),
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
  expect(snapshot.matches({ pause: 'absent' })).toBe(true);
  expect(snapshot.matches({ bufferPressure: 'ok' })).toBe(true);
  await handle.stop();
});

test('startDaemonActors reflects pre-existing PAUSED file via initial sentinel sweep', async () => {
  await writeFile(paths.paused, 'maintenance');
  const handle = await startDaemonActors({ buffer, paths });
  expect(handle.registry.getSnapshot().matches({ pause: 'present' })).toBe(true);
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
  expect(handle.registry.getSnapshot().matches({ pause: 'absent' })).toBe(true);
  await writeFile(paths.paused, 'manual');
  await waitUntilTrue(() => handle.registry.getSnapshot().matches({ pause: 'present' }));
  expect(handle.registry.getSnapshot().matches({ pause: 'present' })).toBe(true);
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
