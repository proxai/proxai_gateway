import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errnoCode, isErrnoException } from 'core/utils/assert.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import type { ServiceManager } from 'cli/service-manager/types.ts';
import {
  deleteUpgradeRestoreState,
  readUpgradeRestoreState,
  writeUpgradeRestoreState,
} from 'services/upgrade/upgrade-restore-state.ts';

const UPGRADE_LOCK = '.upgrade.lock';
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const STOP_POLL_INTERVAL_MS = 500;

export interface CoordinatedUpgradeDeps {
  readonly rootDir: string;
  readonly devCtx: ProfileContext;
  readonly devServiceManager: ServiceManager;
  readonly devConfigExists: () => boolean;
  readonly downloadAndReplaceBinary: () => Promise<void>;
  readonly stopTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CoordinatedUpgradeResult {
  readonly upgradeApplied: boolean;
}

function acquireUpgradeLock(rootDir: string): void {
  const lockPath = join(rootDir, UPGRADE_LOCK);
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(lockPath, 0o600);
    }
  } catch (err) {
    if (isErrnoException(err) && errnoCode(err) === 'EEXIST') {
      throw new Error(`upgrade lock already held: ${lockPath}`, { cause: err });
    }
    throw err;
  }
}

function releaseUpgradeLock(rootDir: string): void {
  rmSync(join(rootDir, UPGRADE_LOCK), { force: true });
}

async function pollUntilStopped(
  serviceManager: ServiceManager,
  deadline: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<boolean> {
  const running = await serviceManager.isRunning();
  if (!running) return true;
  if (Date.now() >= deadline) return false;
  await sleepFn(STOP_POLL_INTERVAL_MS);
  return pollUntilStopped(serviceManager, deadline, sleepFn);
}

export async function coordinatedUpgrade(
  deps: CoordinatedUpgradeDeps,
): Promise<CoordinatedUpgradeResult> {
  const sleepFn = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  acquireUpgradeLock(deps.rootDir);

  let devWasRunning = false;
  try {
    devWasRunning = await deps.devServiceManager.isRunning();

    if (devWasRunning) {
      await writeUpgradeRestoreState(deps.rootDir, { devWasRunning: true });
      await deps.devServiceManager.stop();
      const deadline = Date.now() + timeoutMs;
      const stopped = await pollUntilStopped(deps.devServiceManager, deadline, sleepFn);
      if (!stopped) {
        deleteUpgradeRestoreState(deps.rootDir);
        releaseUpgradeLock(deps.rootDir);
        throw new Error(`dev daemon did not stop within ${timeoutMs}ms; aborting upgrade`);
      }
    }

    await deps.downloadAndReplaceBinary();
  } catch (err) {
    if (devWasRunning) {
      try {
        await deps.devServiceManager.start();
      } catch {}
    }
    releaseUpgradeLock(deps.rootDir);
    throw err;
  }

  releaseUpgradeLock(deps.rootDir);
  return { upgradeApplied: true };
}

export interface UpgradePostRespawnRestoreDeps {
  readonly rootDir: string;
  readonly devCtx: ProfileContext;
  readonly devServiceManager: ServiceManager;
  readonly devConfigExists: () => boolean;
}

export async function runUpgradePostRespawnRestore(
  deps: UpgradePostRespawnRestoreDeps,
): Promise<void> {
  const state = readUpgradeRestoreState(deps.rootDir);
  if (state !== null && state.devWasRunning && deps.devConfigExists()) {
    try {
      await deps.devServiceManager.start();
    } catch {}
  }
  deleteUpgradeRestoreState(deps.rootDir);
  releaseUpgradeLock(deps.rootDir);
}
