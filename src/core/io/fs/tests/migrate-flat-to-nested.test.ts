import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import {
  MIGRATED_MARKER,
  MIGRATION_LOCK,
  isFlatLayoutPresent,
  relocateFlatToNested,
  tryAcquire,
} from 'core/io/fs/migrate-flat-to-nested.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxai-mig-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

test('isFlatLayoutPresent returns false for a nonexistent root', () => {
  expect(isFlatLayoutPresent(join(dir, 'nonexistent'))).toBe(false);
});

test('isFlatLayoutPresent returns false for an empty root dir', () => {
  const root = join(dir, 'empty');
  mkdirSync(root);
  expect(isFlatLayoutPresent(root)).toBe(false);
});

test('isFlatLayoutPresent returns false when migrated marker exists', () => {
  const root = join(dir, 'already-migrated');
  mkdirSync(join(root, 'prod'), { recursive: true });
  writeFileSync(join(root, MIGRATED_MARKER), 'migrated-at=2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'config.toml'), '[backend]');
  expect(isFlatLayoutPresent(root)).toBe(false);
});

test('isFlatLayoutPresent returns true when legacy config.toml sits at root', () => {
  const root = join(dir, 'flat');
  mkdirSync(root);
  writeFileSync(join(root, 'config.toml'), '[backend]');
  expect(isFlatLayoutPresent(root)).toBe(true);
});

test('relocateFlatToNested moves all files to prod/ and writes marker', async () => {
  const root = join(dir, 'flat-full');
  mkdirSync(root);

  writeFileSync(join(root, 'config.toml'), 'config-content');
  writeFileSync(join(root, 'buffer.db'), 'buffer-content');
  writeFileSync(join(root, 'buffer.db-wal'), 'wal-content');
  writeFileSync(join(root, 'buffer.db-shm'), 'shm-content');
  writeFileSync(join(root, 'AUTH_FAILED'), 'auth-content');
  writeFileSync(join(root, 'BUFFER_FULL'), 'bufferfull-content');
  writeFileSync(join(root, 'SESSION_STOPPED'), 'session-content');
  writeFileSync(join(root, 'CONSENT_ACCEPTED'), 'consent-content');
  writeFileSync(join(root, 'UPDATE_AVAILABLE'), 'update-content');
  writeFileSync(join(root, 'DEV_MODE'), 'dev-mode-content');

  await relocateFlatToNested(root);

  const prodDir = join(root, 'prod');
  expect(readFileSync(join(prodDir, 'config.toml'), 'utf8')).toBe('config-content');
  expect(readFileSync(join(prodDir, 'buffer.db'), 'utf8')).toBe('buffer-content');
  expect(readFileSync(join(prodDir, 'buffer.db-wal'), 'utf8')).toBe('wal-content');
  expect(readFileSync(join(prodDir, 'buffer.db-shm'), 'utf8')).toBe('shm-content');
  expect(readFileSync(join(prodDir, 'AUTH_FAILED'), 'utf8')).toBe('auth-content');
  expect(readFileSync(join(prodDir, 'BUFFER_FULL'), 'utf8')).toBe('bufferfull-content');
  expect(readFileSync(join(prodDir, 'SESSION_STOPPED'), 'utf8')).toBe('session-content');
  expect(readFileSync(join(prodDir, 'CONSENT_ACCEPTED'), 'utf8')).toBe('consent-content');
  expect(readFileSync(join(prodDir, 'UPDATE_AVAILABLE'), 'utf8')).toBe('update-content');

  expect(existsSync(join(root, 'DEV_MODE'))).toBe(false);
  expect(existsSync(join(prodDir, 'DEV_MODE'))).toBe(false);

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(root, MIGRATION_LOCK))).toBe(false);

  const markerContent = readFileSync(join(root, MIGRATED_MARKER), 'utf8');
  expect(markerContent.startsWith('migrated-at=')).toBe(true);

  const prodPath = join(root, 'prod');
  expect(prodPath.includes(`${sep}prod`)).toBe(true);
});

test('relocateFlatToNested is idempotent: marker prevents second run', async () => {
  const root = join(dir, 'idempotent');
  mkdirSync(root);
  writeFileSync(join(root, MIGRATED_MARKER), 'migrated-at=2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'config.toml'), 'should-stay-here');

  await relocateFlatToNested(root);

  expect(existsSync(join(root, 'config.toml'))).toBe(true);
  expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(false);
  expect(readFileSync(join(root, 'config.toml'), 'utf8')).toBe('should-stay-here');
});

test('relocateFlatToNested is a no-op when root does not exist', async () => {
  const nonexistent = join(dir, 'never-created');
  await expect(relocateFlatToNested(nonexistent)).resolves.toBeUndefined();
});

test('relocateFlatToNested throws on lock contention and leaves lock file', async () => {
  const root = join(dir, 'locked');
  mkdirSync(root);
  writeFileSync(join(root, 'config.toml'), 'data');

  writeFileSync(join(root, MIGRATION_LOCK), '99999\n');

  await expect(relocateFlatToNested(root, { lockAcquisitionTimeoutMs: 100 })).rejects.toThrow();

  expect(existsSync(join(root, MIGRATION_LOCK))).toBe(true);
});

test('relocateFlatToNested writes marker and returns when root exists but no flat files present', async () => {
  const root = join(dir, 'empty-root');
  mkdirSync(root);

  await relocateFlatToNested(root);

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(root, 'prod'))).toBe(false);
});

test('relocateFlatToNested evicts a stale lock and completes migration', async () => {
  const root = join(dir, 'stale-lock');
  mkdirSync(root);
  writeFileSync(join(root, 'config.toml'), 'stale-cfg');

  const lockPath = join(root, MIGRATION_LOCK);
  writeFileSync(lockPath, '99999\n');

  const farPast = new Date(Date.now() - 120_000);
  const { utimesSync } = await import('node:fs');
  utimesSync(lockPath, farPast, farPast);

  await relocateFlatToNested(root);

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(true);
});

test('lockIsStale treats a dangling symlink lock as stale (catch branch)', async () => {
  const root = join(dir, 'symlink-lock-stale');
  mkdirSync(root);
  writeFileSync(join(root, 'config.toml'), 'data');

  const lockPath = join(root, MIGRATION_LOCK);
  symlinkSync(join(root, 'nonexistent-target'), lockPath);

  await relocateFlatToNested(root);

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(true);
  expect(existsSync(join(root, 'prod', 'config.toml'))).toBe(true);
});

test('tryAcquire rethrows errors that are not EEXIST', async () => {
  const root = join(dir, 'no-write-perm');
  mkdirSync(root);
  writeFileSync(join(root, 'config.toml'), 'data');
  mkdirSync(join(root, MIGRATION_LOCK));

  await expect(relocateFlatToNested(root, { lockAcquisitionTimeoutMs: 500 })).rejects.toThrow();
});

test('tryAcquire rethrows a non-EEXIST write error (missing parent dir → ENOENT)', () => {
  const lockPath = join(dir, 'does-not-exist', MIGRATION_LOCK);
  expect(() => tryAcquire(lockPath)).toThrow();
});
