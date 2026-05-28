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

async function waitUntil(check: () => boolean, timeoutMs = 30_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const step = async (): Promise<void> => {
    if (check() || Date.now() >= deadline) return;
    await sleep(stepMs);
    return step();
  };
  return step();
}

test('classifySentinel returns the right kind for known sentinel filenames', () => {
  expect(classifySentinel('AUTH_FAILED', paths)).toBe('auth-failed');
  expect(classifySentinel('BUFFER_FULL', paths)).toBe('buffer-full');
  expect(classifySentinel('SESSION_STOPPED', paths)).toBe('session-stopped');
  expect(classifySentinel('UPDATE_AVAILABLE', paths)).toBe('update-available');
  expect(classifySentinel('UNRELATED_FILE', paths)).toBeNull();
});

test('initial sweep reports absent state for every sentinel when none exist', async () => {
  watcher = await startSentinelWatcher({ paths, target: registry });
  const s = registry.getSnapshot();
  expect(s.matches({ auth: 'absent' })).toBe(true);
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
  await sleep(250);
  expect(registry.getSnapshot().matches({ auth: 'absent' })).toBe(true);
  await writeFile(
    paths.authFailed,
    JSON.stringify({ reason: 'maintenance', detected_at: '2026-05-25T12:00:00.000Z' }),
  );
  await waitUntil(() => registry.getSnapshot().matches({ auth: 'present' }));
  expect(registry.getSnapshot().matches({ auth: 'present' })).toBe(true);
  expect(registry.getSnapshot().context.authPayload?.reason).toBe('maintenance');
}, 30_000);

test('removing a sentinel file triggers an absent transition', async () => {
  await writeFile(
    paths.authFailed,
    JSON.stringify({ reason: 'maintenance', detected_at: '2026-05-25T12:00:00.000Z' }),
  );
  watcher = await startSentinelWatcher({ paths, target: registry, debounceMs: 20 });
  await sleep(250);
  expect(registry.getSnapshot().matches({ auth: 'present' })).toBe(true);
  await unlink(paths.authFailed);
  await waitUntil(() => registry.getSnapshot().matches({ auth: 'absent' }));
  expect(registry.getSnapshot().matches({ auth: 'absent' })).toBe(true);
}, 30_000);

test('stop() releases the fs.watch loop without errors', async () => {
  watcher = await startSentinelWatcher({ paths, target: registry });
  await watcher.stop();
  watcher = null;
  expect(true).toBe(true);
});

test('dispatch failure is logged via deps.logger.warn without crashing the watcher', async () => {
  let throwOnSend = false;
  const conditionalTarget = {
    send: (): void => {
      if (throwOnSend) throw new Error('target boom');
    },
  };
  const warnCalls: Record<string, unknown>[] = [];
  const fakeLogger = {
    warn: (fields: Record<string, unknown>): void => {
      warnCalls.push(fields);
    },
    info: (): void => {},
    debug: (): void => {},
    trace: (): void => {},
    error: (): void => {},
    fatal: (): void => {},
    child: () => fakeLogger,
    level: 'info',
    silent: () => fakeLogger,
    bindings: () => ({}),
    flush: () => {},
    isLevelEnabled: () => true,
  };
  const local = await startSentinelWatcher({
    paths,
    target: conditionalTarget,
    debounceMs: 20,
    logger: fakeLogger as never,
  });
  await sleep(250);
  throwOnSend = true;
  await writeFile(
    paths.authFailed,
    JSON.stringify({ reason: 'maintenance', detected_at: '2026-05-25T12:00:00.000Z' }),
  );
  await waitUntil(() => warnCalls.some((c) => c['event'] === 'sentinel_watcher.dispatch_failed'));
  await local.stop();
  expect(warnCalls.some((c) => c['event'] === 'sentinel_watcher.dispatch_failed')).toBe(true);
}, 30_000);

test('fs.watch errors on a missing configDir are logged via deps.logger.warn', async () => {
  await rmRecursive(dir);
  const warnCalls: Record<string, unknown>[] = [];
  const fakeLogger = {
    warn: (fields: Record<string, unknown>): void => {
      warnCalls.push(fields);
    },
    info: (): void => {},
    debug: (): void => {},
    trace: (): void => {},
    error: (): void => {},
    fatal: (): void => {},
    child: () => fakeLogger,
    level: 'info',
    silent: () => fakeLogger,
    bindings: () => ({}),
    flush: () => {},
    isLevelEnabled: () => true,
  };
  const local = await startSentinelWatcher({
    paths,
    target: registry,
    logger: fakeLogger as never,
  });
  await waitUntil(() => warnCalls.some((c) => c['event'] === 'sentinel_watcher.fatal'));
  await local.stop();
  dir = await mkdtemp(join(tmpdir(), 'proxai-sentinel-watcher-restored-'));
  expect(warnCalls.some((c) => c['event'] === 'sentinel_watcher.fatal')).toBe(true);
}, 30_000);
