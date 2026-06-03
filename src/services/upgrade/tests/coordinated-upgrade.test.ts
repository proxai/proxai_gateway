import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import type { ServiceManager } from 'cli/service-manager/types.ts';
import {
  coordinatedUpgrade,
  runUpgradePostRespawnRestore,
} from 'services/upgrade/coordinated-upgrade.ts';
import {
  readUpgradeRestoreState,
  UPGRADE_RESTORE_STATE_FILE,
  writeUpgradeRestoreState,
} from 'services/upgrade/upgrade-restore-state.ts';

const UPGRADE_LOCK = '.upgrade.lock';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-coordinated-upgrade-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

const devCtx: ProfileContext = buildProfileContext('dev');

interface FakeServiceManagerOptions {
  readonly runningSequence?: boolean[];
  readonly onStart?: () => void | Promise<void>;
  readonly onStop?: () => void | Promise<void>;
  readonly startThrows?: boolean;
}

function buildFakeServiceManager(
  calls: string[],
  options: FakeServiceManagerOptions = {},
): ServiceManager {
  const sequence = options.runningSequence ?? [];
  let callIndex = 0;
  return {
    ensureRegistered: async () => {
      calls.push('ensureRegistered');
    },
    start: async () => {
      calls.push('start');
      if (options.startThrows === true) throw new Error('start failed');
      await options.onStart?.();
    },
    stop: async () => {
      calls.push('stop');
      await options.onStop?.();
    },
    restart: async () => {
      calls.push('restart');
    },
    unregister: async () => {
      calls.push('unregister');
    },
    isRegistered: async () => false,
    isRunning: async () => {
      const value = sequence[callIndex] ?? false;
      callIndex += 1;
      calls.push(`isRunning:${String(value)}`);
      return value;
    },
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
}

test('happy path: dev running is stopped, binary replaced, state cleared, lock released', async () => {
  const calls: string[] = [];
  const sleepCalls: number[] = [];
  let replaced = false;
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, false],
  });

  const result = await coordinatedUpgrade({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
    downloadAndReplaceBinary: async () => {
      calls.push('replace');
      replaced = true;
      if (process.platform !== 'win32') {
        const lockPath = join(dir, UPGRADE_LOCK);
        const stat = require('node:fs').statSync(lockPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  expect(result.upgradeApplied).toBe(true);
  expect(replaced).toBe(true);
  expect(calls).toEqual(['isRunning:true', 'stop', 'isRunning:false', 'replace']);
  expect(sleepCalls).toHaveLength(0);
  expect(readUpgradeRestoreState(dir)).toEqual({ devWasRunning: true });
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('dev daemon absent: dev stop and restart are skipped', async () => {
  const calls: string[] = [];
  let replaced = false;
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [false],
  });

  const result = await coordinatedUpgrade({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => false,
    downloadAndReplaceBinary: async () => {
      replaced = true;
      calls.push('replace');
    },
  });

  expect(result.upgradeApplied).toBe(true);
  expect(replaced).toBe(true);
  expect(calls).toEqual(['isRunning:false', 'replace']);
  expect(existsSync(join(dir, UPGRADE_RESTORE_STATE_FILE))).toBe(false);
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('poll loop retries via sleep until the dev daemon reports stopped', async () => {
  const calls: string[] = [];
  const sleepCalls: number[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, true, true, false],
  });

  await coordinatedUpgrade({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
    downloadAndReplaceBinary: async () => {
      calls.push('replace');
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  expect(calls).toEqual([
    'isRunning:true',
    'stop',
    'isRunning:true',
    'isRunning:true',
    'isRunning:false',
    'replace',
  ]);
  expect(sleepCalls).toEqual([500, 500]);
});

test('poll timeout: state deleted, dev restarted, lock released, error thrown', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, true],
  });

  await expect(
    coordinatedUpgrade({
      rootDir: dir,
      devCtx,
      devServiceManager,
      devConfigExists: () => true,
      downloadAndReplaceBinary: async () => {
        calls.push('replace');
      },
      stopTimeoutMs: 0,
      sleep: async () => {},
    }),
  ).rejects.toThrow('dev daemon did not stop within 0ms; aborting upgrade');

  expect(calls).toEqual(['isRunning:true', 'stop', 'isRunning:true', 'start']);
  expect(existsSync(join(dir, UPGRADE_RESTORE_STATE_FILE))).toBe(false);
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('replace failure with dev running: dev restarted, lock released, error rethrown', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, false],
  });

  await expect(
    coordinatedUpgrade({
      rootDir: dir,
      devCtx,
      devServiceManager,
      devConfigExists: () => true,
      downloadAndReplaceBinary: async () => {
        throw new Error('replace boom');
      },
      sleep: async () => {},
    }),
  ).rejects.toThrow('replace boom');

  expect(calls).toEqual(['isRunning:true', 'stop', 'isRunning:false', 'start']);
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('replace failure restart that itself throws is swallowed; original error rethrown', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, false],
    startThrows: true,
  });

  await expect(
    coordinatedUpgrade({
      rootDir: dir,
      devCtx,
      devServiceManager,
      devConfigExists: () => true,
      downloadAndReplaceBinary: async () => {
        throw new Error('replace boom');
      },
      sleep: async () => {},
    }),
  ).rejects.toThrow('replace boom');

  expect(calls).toEqual(['isRunning:true', 'stop', 'isRunning:false', 'start']);
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('replace failure with dev not running: no restart attempted', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [false],
  });

  await expect(
    coordinatedUpgrade({
      rootDir: dir,
      devCtx,
      devServiceManager,
      devConfigExists: () => false,
      downloadAndReplaceBinary: async () => {
        throw new Error('replace boom');
      },
    }),
  ).rejects.toThrow('replace boom');

  expect(calls).toEqual(['isRunning:false']);
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('default sleep and stopTimeoutMs are used when omitted (dev not running)', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [false],
  });

  const result = await coordinatedUpgrade({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => false,
    downloadAndReplaceBinary: async () => {},
  });

  expect(result.upgradeApplied).toBe(true);
});

test('default sleep is used in the poll loop when sleep dep is omitted', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls, {
    runningSequence: [true, true, false],
  });

  const result = await coordinatedUpgrade({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
    downloadAndReplaceBinary: async () => {
      calls.push('replace');
    },
  });

  expect(result.upgradeApplied).toBe(true);
  expect(calls).toEqual(['isRunning:true', 'stop', 'isRunning:true', 'isRunning:false', 'replace']);
}, 30_000);

test('acquire lock throws a friendly error when the lock is already held', async () => {
  const calls: string[] = [];
  writeFileSync(join(dir, UPGRADE_LOCK), '999\n');
  const devServiceManager = buildFakeServiceManager(calls, { runningSequence: [false] });

  await expect(
    coordinatedUpgrade({
      rootDir: dir,
      devCtx,
      devServiceManager,
      devConfigExists: () => false,
      downloadAndReplaceBinary: async () => {},
    }),
  ).rejects.toThrow('upgrade lock already held');

  expect(calls).toHaveLength(0);
});

test('acquire lock rethrows a non-EEXIST error (parent dir missing)', async () => {
  const calls: string[] = [];
  const missingRoot = join(dir, 'does', 'not', 'exist');
  const devServiceManager = buildFakeServiceManager(calls, { runningSequence: [false] });

  await expect(
    coordinatedUpgrade({
      rootDir: missingRoot,
      devCtx,
      devServiceManager,
      devConfigExists: () => false,
      downloadAndReplaceBinary: async () => {},
    }),
  ).rejects.toThrow();

  expect(calls).toHaveLength(0);
});

test('runUpgradePostRespawnRestore: restarts dev when state says it was running and config exists', async () => {
  const calls: string[] = [];
  writeFileSync(join(dir, UPGRADE_LOCK), '1\n');
  await writeUpgradeRestoreState(dir, { devWasRunning: true });
  const devServiceManager = buildFakeServiceManager(calls);

  await runUpgradePostRespawnRestore({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
  });

  expect(calls).toEqual(['start']);
  expect(readUpgradeRestoreState(dir)).toBeNull();
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('runUpgradePostRespawnRestore: start error is swallowed and cleanup still runs', async () => {
  const calls: string[] = [];
  writeFileSync(join(dir, UPGRADE_LOCK), '1\n');
  await writeUpgradeRestoreState(dir, { devWasRunning: true });
  const devServiceManager = buildFakeServiceManager(calls, { startThrows: true });

  await runUpgradePostRespawnRestore({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
  });

  expect(calls).toEqual(['start']);
  expect(readUpgradeRestoreState(dir)).toBeNull();
  expect(existsSync(join(dir, UPGRADE_LOCK))).toBe(false);
});

test('runUpgradePostRespawnRestore: skips restart when state is absent', async () => {
  const calls: string[] = [];
  const devServiceManager = buildFakeServiceManager(calls);

  await runUpgradePostRespawnRestore({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
  });

  expect(calls).toHaveLength(0);
});

test('runUpgradePostRespawnRestore: skips restart when state says dev was not running', async () => {
  const calls: string[] = [];
  await writeUpgradeRestoreState(dir, { devWasRunning: false });
  const devServiceManager = buildFakeServiceManager(calls);

  await runUpgradePostRespawnRestore({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => true,
  });

  expect(calls).toHaveLength(0);
  expect(readUpgradeRestoreState(dir)).toBeNull();
});

test('runUpgradePostRespawnRestore: skips restart when dev config no longer exists', async () => {
  const calls: string[] = [];
  await writeUpgradeRestoreState(dir, { devWasRunning: true });
  const devServiceManager = buildFakeServiceManager(calls);

  await runUpgradePostRespawnRestore({
    rootDir: dir,
    devCtx,
    devServiceManager,
    devConfigExists: () => false,
  });

  expect(calls).toHaveLength(0);
  expect(readUpgradeRestoreState(dir)).toBeNull();
});
