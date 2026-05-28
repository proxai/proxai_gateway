import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errnoCode, isErrnoException } from 'core/utils/assert.ts';

export const MIGRATED_MARKER = '.migrated-flat-to-nested';
export const MIGRATION_LOCK = '.migration.lock';
const STALE_LOCK_AGE_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 100;

const SENTINEL_FILES = [
  'AUTH_FAILED',
  'BUFFER_FULL',
  'SESSION_STOPPED',
  'CONSENT_ACCEPTED',
  'UPDATE_AVAILABLE',
] as const;

const BUFFER_COMPANIONS = ['buffer.db', 'buffer.db-wal', 'buffer.db-shm'] as const;

const FILES_TO_RELOCATE = ['config.toml', ...BUFFER_COMPANIONS, ...SENTINEL_FILES];

const FILES_TO_DELETE_NOT_MOVE = ['DEV_MODE'];

export interface RelocateOptions {
  readonly lockAcquisitionTimeoutMs?: number;
}

export function isFlatLayoutPresent(root: string): boolean {
  if (!existsSync(root)) return false;
  if (existsSync(join(root, MIGRATED_MARKER))) return false;
  return FILES_TO_RELOCATE.some((name) => existsSync(join(root, name)));
}

export async function relocateFlatToNested(
  root: string,
  options: RelocateOptions = {},
): Promise<void> {
  if (!existsSync(root)) return;
  if (existsSync(join(root, MIGRATED_MARKER))) return;
  if (!isFlatLayoutPresent(root)) {
    writeMarker(root);
    return;
  }

  const timeoutMs = options.lockAcquisitionTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  await acquireLock(root, timeoutMs);
  try {
    if (existsSync(join(root, MIGRATED_MARKER))) return;
    const prodDir = join(root, 'prod');
    if (!existsSync(prodDir)) mkdirSync(prodDir, { recursive: true });

    for (const name of FILES_TO_DELETE_NOT_MOVE) {
      const src = join(root, name);
      if (existsSync(src)) rmSync(src);
    }

    for (const name of FILES_TO_RELOCATE) {
      const src = join(root, name);
      const dst = join(prodDir, name);
      if (existsSync(src) && !existsSync(dst)) {
        renameSync(src, dst);
      }
    }

    writeMarker(root);
  } finally {
    releaseLock(root);
  }
}

function writeMarker(root: string): void {
  const stamp = `migrated-at=${new Date().toISOString()}\n`;
  writeFileSync(join(root, MIGRATED_MARKER), stamp);
}

async function acquireLock(root: string, timeoutMs: number): Promise<void> {
  const lockPath = join(root, MIGRATION_LOCK);
  const deadline = Date.now() + timeoutMs;
  return acquireLockStep(lockPath, deadline, timeoutMs);
}

async function acquireLockStep(
  lockPath: string,
  deadline: number,
  timeoutMs: number,
): Promise<void> {
  if (tryAcquire(lockPath)) return;
  if (lockIsStale(lockPath)) {
    rmSync(lockPath, { force: true });
    return acquireLockStep(lockPath, deadline, timeoutMs);
  }
  if (Date.now() >= deadline) {
    throw new Error(`migration lock not acquired within ${timeoutMs}ms: ${lockPath}`);
  }
  await sleep(LOCK_RETRY_INTERVAL_MS);
  return acquireLockStep(lockPath, deadline, timeoutMs);
}

function tryAcquire(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (isErrnoException(err) && errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    return ageMs > STALE_LOCK_AGE_MS;
  } catch {
    return true;
  }
}

function releaseLock(root: string): void {
  const lockPath = join(root, MIGRATION_LOCK);
  try {
    rmSync(lockPath, { force: true });
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
