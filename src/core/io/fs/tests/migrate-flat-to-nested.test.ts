import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
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

let shouldRenameSyncFailForRollback = false;
let shouldReadFileSyncFailForConfig = false;
let shouldRmSyncFailForReleaseLock = false;

mock.module('node:fs', () => {
  const actual = require('node:fs');
  return {
    ...actual,
    renameSync: (src: string, dst: string) => {
      if (
        shouldRenameSyncFailForRollback &&
        dst.includes('config.toml') &&
        !dst.includes(`${sep}prod${sep}`)
      ) {
        throw new Error('mock renameSync failure');
      }
      return actual.renameSync(src, dst);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (
        shouldReadFileSyncFailForConfig &&
        typeof path === 'string' &&
        path.includes('config.toml')
      ) {
        throw new Error('mock readFileSync failure');
      }
      return actual.readFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = args[0];
      if (
        shouldRmSyncFailForReleaseLock &&
        typeof path === 'string' &&
        path.includes('.migration.lock')
      ) {
        throw new Error('mock rmSync failure');
      }
      return actual.rmSync(...args);
    },
  };
});

import { rmRecursive } from 'core/io/fs';
import { profileLogDirRoot } from 'core/io/fs/profile.ts';
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
  shouldRenameSyncFailForRollback = false;
  shouldReadFileSyncFailForConfig = false;
  shouldRmSyncFailForReleaseLock = false;
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

test('tryAcquire creates lock file with 0o600 permissions on non-Windows', async () => {
  if (process.platform === 'win32') return;
  const lockPath = join(dir, 'perm.lock');
  const acquired = tryAcquire(lockPath);
  expect(acquired).toBe(true);
  const { statSync } = await import('node:fs');
  const s = statSync(lockPath);
  expect(s.mode & 0o777).toBe(0o600);
});

test('relocateFlatToNested rewrites config.toml buffer_path to prod/ when it matches legacy path', async () => {
  const root = join(dir, 'rewrite-config');
  mkdirSync(root);

  const flatConfigPath = join(root, 'config.toml');
  const flatBufferPath = join(root, 'buffer.db');

  const tomlContent = `
[capture]
poll_interval_sec = 10
buffer_path = "${flatBufferPath.replace(/\\/g, '\\\\')}"
`;
  writeFileSync(flatConfigPath, tomlContent);
  writeFileSync(flatBufferPath, 'db-content');

  await relocateFlatToNested(root);

  const prodDir = join(root, 'prod');
  const relocatedConfigPath = join(prodDir, 'config.toml');
  const relocatedBufferPath = join(prodDir, 'buffer.db');

  expect(existsSync(relocatedConfigPath)).toBe(true);
  expect(existsSync(relocatedBufferPath)).toBe(true);

  const newContent = readFileSync(relocatedConfigPath, 'utf8');
  expect(newContent).toContain('buffer_path');
  expect(newContent).toContain(join('prod', 'buffer.db').replace(/\\/g, '\\\\'));
  expect(newContent).not.toContain(flatBufferPath.replace(/\\/g, '\\\\') + '"');
});

test('relocateFlatToNested rolls back already-relocated files if any file relocation fails (atomic)', async () => {
  const root = join(dir, 'atomic-rollback');
  mkdirSync(root);

  const flatConfig = join(root, 'config.toml');
  const flatBuffer = join(root, 'buffer.db');

  writeFileSync(flatConfig, 'config-content');
  writeFileSync(flatBuffer, 'buffer-content');

  const prodDir = join(root, 'prod');
  mkdirSync(prodDir, { recursive: true });
  mkdirSync(join(prodDir, 'buffer.db'), { recursive: true });

  await expect(relocateFlatToNested(root)).rejects.toThrow();

  expect(existsSync(flatConfig)).toBe(true);
  expect(readFileSync(flatConfig, 'utf8')).toBe('config-content');
  expect(existsSync(flatBuffer)).toBe(true);
  expect(readFileSync(flatBuffer, 'utf8')).toBe('buffer-content');

  expect(existsSync(join(root, MIGRATED_MARKER))).toBe(false);
});

test('relocateFlatToNested rewrites config.toml log_dir to prod/ when it matches legacy path', async () => {
  const root = join(dir, 'rewrite-logging');
  mkdirSync(root);

  const flatConfigPath = join(root, 'config.toml');
  const oldLogDir = profileLogDirRoot();

  const tomlContent = `
[logging]
log_dir = "${oldLogDir.replace(/\\/g, '\\\\')}"
`;
  writeFileSync(flatConfigPath, tomlContent);

  await relocateFlatToNested(root);

  const prodDir = join(root, 'prod');
  const relocatedConfigPath = join(prodDir, 'config.toml');
  expect(existsSync(relocatedConfigPath)).toBe(true);

  const newContent = readFileSync(relocatedConfigPath, 'utf8');
  expect(newContent).toContain('log_dir');
  expect(newContent).toContain(join(oldLogDir, 'prod').replace(/\\/g, '\\\\'));
});

test('relocateFlatToNested console.errors and ignores rollback failures', async () => {
  const root = join(dir, 'rollback-failure');
  mkdirSync(root);

  const flatConfig = join(root, 'config.toml');
  const flatBuffer = join(root, 'buffer.db');

  writeFileSync(flatConfig, 'config-content');
  writeFileSync(flatBuffer, 'buffer-content');

  const prodDir = join(root, 'prod');
  mkdirSync(prodDir, { recursive: true });
  mkdirSync(join(prodDir, 'buffer.db'), { recursive: true });

  let errorCallCount = 0;
  let loggedMessage = '';
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorCallCount += 1;
    loggedMessage = String(args[0]);
  });

  shouldRenameSyncFailForRollback = true;
  try {
    await expect(relocateFlatToNested(root)).rejects.toThrow();
  } finally {
    shouldRenameSyncFailForRollback = false;
    errorSpy.mockRestore();
  }

  expect(errorCallCount).toBe(1);
  expect(loggedMessage).toContain('failed to rollback relocated file');
});

test('relocateFlatToNested ignores errors during config.toml rewrite', async () => {
  const root = join(dir, 'config-rewrite-error');
  mkdirSync(root);

  const flatConfigPath = join(root, 'config.toml');
  writeFileSync(flatConfigPath, 'some-toml-data');

  shouldReadFileSyncFailForConfig = true;
  try {
    await relocateFlatToNested(root);
  } finally {
    shouldReadFileSyncFailForConfig = false;
  }

  const prodDir = join(root, 'prod');
  expect(existsSync(join(prodDir, 'config.toml'))).toBe(true);
});

test('tryAcquire skips chmodSync on win32 platform', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });
  try {
    const lockPath = join(dir, 'win32-acquire.lock');
    const result = tryAcquire(lockPath);
    expect(result).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  }
});

test('releaseLock swallows errors when rmSync throws', async () => {
  const root = join(dir, 'release-lock-error');
  mkdirSync(root);

  // Trigger relocation which calls releaseLock in finally
  // Set mock to make rmSync throw
  const flatConfigPath = join(root, 'config.toml');
  writeFileSync(flatConfigPath, 'some-toml-data');

  shouldRmSyncFailForReleaseLock = true;
  try {
    // Should complete successfully because rmSync failure is swallowed
    await relocateFlatToNested(root);
  } finally {
    shouldRmSyncFailForReleaseLock = false;
  }
});
