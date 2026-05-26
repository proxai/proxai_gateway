import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor } from 'xstate';
import { sentinelRegistryMachine } from 'services/state-machines/sentinel-registry/sentinel-registry.machine.ts';
import { classifySentinel, startSentinelWatcher } from 'services/state-machines/sentinel-watcher';
import type {
  SentinelWatcherHandle,
  SentinelWatcherPaths,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.types.ts';

let dir: string;
let paths: SentinelWatcherPaths;
let registry: ReturnType<typeof createActor<typeof sentinelRegistryMachine>>;
let watcher: SentinelWatcherHandle | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-sentinel-watcher-'));
  paths = {
    configDir: dir,
    authFailed: join(dir, 'AUTH_FAILED'),
    paused: join(dir, 'PAUSED'),
    bufferFull: join(dir, 'BUFFER_FULL'),
    sessionStopped: join(dir, 'SESSION_STOPPED'),
    updateAvailable: join(dir, 'UPDATE_AVAILABLE'),
  };
  registry = createActor(sentinelRegistryMachine);
  registry.start();
  watcher = null;
});

afterEach(async () => {
  if (watcher !== null) await watcher.stop();
  registry.stop();
  await rmRecursive(dir);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('classifySentinel returns the right kind for known sentinel filenames', () => {
  expect(classifySentinel('AUTH_FAILED', paths)).toBe('auth-failed');
  expect(classifySentinel('PAUSED', paths)).toBe('paused');
  expect(classifySentinel('BUFFER_FULL', paths)).toBe('buffer-full');
  expect(classifySentinel('SESSION_STOPPED', paths)).toBe('session-stopped');
  expect(classifySentinel('UPDATE_AVAILABLE', paths)).toBe('update-available');
  expect(classifySentinel('UNRELATED_FILE', paths)).toBeNull();
});

test('initial sweep reports absent state for every sentinel when none exist', async () => {
  watcher = await startSentinelWatcher({ paths, target: registry });
  const s = registry.getSnapshot();
  expect(s.matches({ auth: 'absent' })).toBe(true);
  expect(s.matches({ pause: 'absent' })).toBe(true);
  expect(s.matches({ bufferPressure: 'ok' })).toBe(true);
  expect(s.matches({ session: 'live' })).toBe(true);
});

test('initial sweep reports present state for a sentinel that exists on disk', async () => {
  await writeFile(
    paths.authFailed,
    JSON.stringify({ reason: 'invalid_key', detected_at: '2026-05-25T12:00:00.000Z' }),
  );
  watcher = await startSentinelWatcher({ paths, target: registry });
  expect(registry.getSnapshot().matches({ auth: 'present' })).toBe(true);
  expect(registry.getSnapshot().context.authPayload?.reason).toBe('invalid_key');
});

test('writing a sentinel file triggers a present transition via fs.watch (debounced)', async () => {
  watcher = await startSentinelWatcher({ paths, target: registry, debounceMs: 20 });
  expect(registry.getSnapshot().matches({ pause: 'absent' })).toBe(true);
  await writeFile(paths.paused, 'maintenance');
  await sleep(300);
  expect(registry.getSnapshot().matches({ pause: 'present' })).toBe(true);
  expect(registry.getSnapshot().context.pausePayload?.reason).toBe('maintenance');
});

test('removing a sentinel file triggers an absent transition', async () => {
  await writeFile(paths.paused, 'maintenance');
  watcher = await startSentinelWatcher({ paths, target: registry, debounceMs: 20 });
  expect(registry.getSnapshot().matches({ pause: 'present' })).toBe(true);
  await unlink(paths.paused);
  await sleep(300);
  expect(registry.getSnapshot().matches({ pause: 'absent' })).toBe(true);
});

test('stop() releases the fs.watch loop without errors', async () => {
  watcher = await startSentinelWatcher({ paths, target: registry });
  await watcher.stop();
  watcher = null;
  expect(true).toBe(true);
});
