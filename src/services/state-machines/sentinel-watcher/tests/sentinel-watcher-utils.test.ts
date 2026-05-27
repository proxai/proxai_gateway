import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAbsentEvent,
  buildPresentEvent,
  classifySentinel,
  fileExists,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.utils.ts';
import type {
  SentinelKind,
  SentinelWatcherPaths,
} from 'services/state-machines/sentinel-watcher/sentinel-watcher.types.ts';

let dir: string;
let paths: SentinelWatcherPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-watcher-utils-'));
  paths = {
    configDir: dir,
    authFailed: join(dir, 'AUTH_FAILED'),
    bufferFull: join(dir, 'BUFFER_FULL'),
    sessionStopped: join(dir, 'SESSION_STOPPED'),
    updateAvailable: join(dir, 'UPDATE_AVAILABLE'),
  };
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('classifySentinel returns null for unrelated filenames', () => {
  expect(classifySentinel('config.toml', paths)).toBeNull();
  expect(classifySentinel('', paths)).toBeNull();
});

test('classifySentinel maps each known filename to its kind', () => {
  const cases: [string, SentinelKind][] = [
    ['AUTH_FAILED', 'auth-failed'],
    ['BUFFER_FULL', 'buffer-full'],
    ['SESSION_STOPPED', 'session-stopped'],
    ['UPDATE_AVAILABLE', 'update-available'],
  ];
  for (const [filename, kind] of cases) {
    expect(classifySentinel(filename, paths)).toBe(kind);
  }
});

test('fileExists returns true for an existing file and false otherwise', async () => {
  await writeFile(paths.authFailed, '{"reason":"x","detected_at":"x"}');
  expect(await fileExists(paths.authFailed)).toBe(true);
  expect(await fileExists(paths.bufferFull)).toBe(false);
});

test('buildPresentEvent for auth-failed reads the JSON payload', async () => {
  await writeFile(
    paths.authFailed,
    JSON.stringify({ reason: 'invalid_key', detected_at: '2026-05-25T12:00:00.000Z' }),
  );
  const event = await buildPresentEvent('auth-failed', paths);
  expect(event?.type).toBe('AUTH_FAILED_WRITTEN');
  if (event?.type === 'AUTH_FAILED_WRITTEN') {
    expect(event.payload.reason).toBe('invalid_key');
    expect(event.payload.detectedAtUtc).toBe('2026-05-25T12:00:00.000Z');
  }
});

test('buildPresentEvent for auth-failed without detected_at substitutes current time', async () => {
  await writeFile(paths.authFailed, JSON.stringify({ reason: 'no-key' }));
  const event = await buildPresentEvent('auth-failed', paths);
  expect(event?.type).toBe('AUTH_FAILED_WRITTEN');
  if (event?.type === 'AUTH_FAILED_WRITTEN') {
    expect(event.payload.detectedAtUtc.length).toBeGreaterThan(0);
  }
});

test('buildPresentEvent for auth-failed returns null when sentinel body is missing/empty', async () => {
  await writeFile(paths.authFailed, '');
  const event = await buildPresentEvent('auth-failed', paths);
  expect(event).toBeNull();
});

test('buildPresentEvent for buffer-full reads JSON pendingBytes and threshold', async () => {
  await writeFile(
    paths.bufferFull,
    JSON.stringify({
      pending_bytes: 60_000_000_000,
      threshold: 50_000_000_000,
      set_at: '2026-05-25T12:00:00.000Z',
    }),
  );
  const event = await buildPresentEvent('buffer-full', paths);
  expect(event?.type).toBe('PRESSURE_CROSSED_PAUSE');
  if (event?.type === 'PRESSURE_CROSSED_PAUSE') {
    expect(event.payload.pendingBytes).toBe(60_000_000_000);
    expect(event.payload.thresholdBytes).toBe(50_000_000_000);
    expect(event.payload.setAtUtc).toBe('2026-05-25T12:00:00.000Z');
  }
});

test('buildPresentEvent for buffer-full returns null when sentinel is unreadable', async () => {
  await writeFile(paths.bufferFull, '');
  const event = await buildPresentEvent('buffer-full', paths);
  expect(event).toBeNull();
});

test('buildPresentEvent for session-stopped reads the boot_id and set_at fields', async () => {
  await writeFile(
    paths.sessionStopped,
    JSON.stringify({ boot_id: 'boot-abc', set_at: '2026-05-25T12:00:00.000Z' }),
  );
  const event = await buildPresentEvent('session-stopped', paths);
  expect(event?.type).toBe('STOP_REQUESTED');
  if (event?.type === 'STOP_REQUESTED') {
    expect(event.payload.bootId).toBe('boot-abc');
    expect(event.payload.setAtUtc).toBe('2026-05-25T12:00:00.000Z');
  }
});

test('buildPresentEvent for session-stopped returns null when boot_id missing', async () => {
  await writeFile(paths.sessionStopped, JSON.stringify({ set_at: '2026-05-25T12:00:00.000Z' }));
  const event = await buildPresentEvent('session-stopped', paths);
  expect(event).toBeNull();
});

test('buildPresentEvent for update-available reads version metadata', async () => {
  await writeFile(
    paths.updateAvailable,
    JSON.stringify({
      latest_version: '2026.5.10',
      current_version: '2026.5.1',
      detected_at: '2026-05-25T12:00:00.000Z',
      asset_url: 'https://example/asset',
    }),
  );
  const event = await buildPresentEvent('update-available', paths);
  expect(event?.type).toBe('BREW_UPDATE_AVAILABLE');
  if (event?.type === 'BREW_UPDATE_AVAILABLE') {
    expect(event.payload.latestVersion).toBe('2026.5.10');
    expect(event.payload.currentVersion).toBe('2026.5.1');
    expect(event.payload.assetUrl).toBe('https://example/asset');
  }
});

test('buildPresentEvent for update-available without asset_url defaults to null', async () => {
  await writeFile(
    paths.updateAvailable,
    JSON.stringify({
      latest_version: '2026.5.10',
      current_version: '2026.5.1',
      detected_at: '2026-05-25T12:00:00.000Z',
    }),
  );
  const event = await buildPresentEvent('update-available', paths);
  expect(event?.type).toBe('BREW_UPDATE_AVAILABLE');
  if (event?.type === 'BREW_UPDATE_AVAILABLE') {
    expect(event.payload.assetUrl).toBeNull();
  }
});

test('buildPresentEvent for update-available returns null when version fields are missing', async () => {
  await writeFile(paths.updateAvailable, JSON.stringify({ latest_version: '' }));
  const event = await buildPresentEvent('update-available', paths);
  expect(event).toBeNull();
});

test('buildAbsentEvent returns matching cleared/resume events for each kind', () => {
  expect(buildAbsentEvent('auth-failed').type).toBe('AUTH_FAILED_CLEARED');
  expect(buildAbsentEvent('buffer-full').type).toBe('PRESSURE_CROSSED_RESUME');
  expect(buildAbsentEvent('session-stopped').type).toBe('BOOT_ID_MISMATCH');
  const brew = buildAbsentEvent('update-available');
  expect(brew.type).toBe('BREW_UP_TO_DATE');
  if (brew.type === 'BREW_UP_TO_DATE') {
    expect(brew.latestVersion).toBe('');
  }
});
