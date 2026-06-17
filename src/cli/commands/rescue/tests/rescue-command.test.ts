import { expect, test, mock, afterEach, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { runRescue } from 'cli/commands/rescue/index.ts';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';
import {
  readRescueLedger,
  writeRescueLedger,
  clearRescueLedger,
} from 'services/rescue/rescue-ledger.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { readBootId } from 'core/system/boot-id.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { requireDefined } from 'core/utils';

let mockDecisionKind: 'none' | 'start' | 'restart' | 'paused' = 'none';
let originalBootId: string | undefined;
let lastDecisionInput: unknown = null;
let mockHeartbeat = {
  captureLastCycleAt: null as string | null,
  drainLastCycleAt: null as string | null,
};

mock.module('services/rescue/rescue-decision.ts', () => ({
  decideRescue: (input: unknown) => {
    lastDecisionInput = input;
    if (mockDecisionKind === 'start') {
      return { kind: 'start' };
    }
    if (mockDecisionKind === 'restart') {
      return { kind: 'restart' };
    }
    if (mockDecisionKind === 'paused') {
      return { kind: 'none', reason: 'paused' };
    }
    return { kind: 'none', reason: 'healthy' };
  },
}));

mock.module('services/rescue/heartbeat-read.ts', () => ({
  readHeartbeat: () => mockHeartbeat,
}));

beforeEach(() => {
  originalBootId = process.env['PROXAI_TEST_BOOT_ID'];
  process.env['PROXAI_TEST_BOOT_ID'] = 'mock-boot-id';
});

afterEach(() => {
  mockDecisionKind = 'none';
  mockHeartbeat = { captureLastCycleAt: null, drainLastCycleAt: null };
  if (originalBootId === undefined) {
    delete process.env['PROXAI_TEST_BOOT_ID'];
  } else {
    process.env['PROXAI_TEST_BOOT_ID'] = originalBootId;
  }
});

test('runRescue starts daemon on start decision', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-1');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    mockDecisionKind = 'start';
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);

    const startedServices: string[] = [];
    const { spawn } = mockSpawn((argv) => {
      if (argv.includes('start')) {
        startedServices.push(argv.join(' '));
      }
      return { exitCode: 0 };
    });

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    const bootId = await readBootId();
    const ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger).not.toBeNull();
    expect(ledger?.consecutiveFailures).toBe(0);
    expect(ledger?.attempts.length).toBe(1);
    expect(ledger?.attempts[0]?.action).toBe('start');

    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue restarts daemon on restart decision', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-2');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    mockDecisionKind = 'restart';
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);

    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    const bootId = await readBootId();
    const ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger).not.toBeNull();
    expect(ledger?.consecutiveFailures).toBe(1);
    expect(ledger?.attempts.length).toBe(2);
    expect(ledger?.attempts[0]?.action).toBe('restart');
    expect(ledger?.attempts[1]?.action).toBe('restart');

    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue clears consecutiveFailures on none/healthy decision', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-3');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    mockDecisionKind = 'none';
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);

    const bootId = await readBootId();
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, {
      bootId,
      lastRescueAt: null,
      consecutiveFailures: 2,
      attempts: [],
      lastObservedCaptureAt: null,
      lastObservedDrainAt: null,
      lastWatchdogRunAt: null,
    });

    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    const ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger).not.toBeNull();
    expect(ledger?.consecutiveFailures).toBe(0);

    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue logs error on exception', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-4');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    mockDecisionKind = 'start';
    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    const result = await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'unsupported' as unknown as NodeJS.Platform,
      spawn,
      skipExit: true,
    });

    expect(result.exitCode).toBe(EXIT_CODE.ok);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue none/paused decision', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-5');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    mockDecisionKind = 'paused';
    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
    const result = await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    expect(result.exitCode).toBe(EXIT_CODE.ok);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue calls process.exit when skipExit is false', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-6');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;
  const originalExit = process.exit;
  let exitCode = -1;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as unknown as typeof process.exit;

  try {
    mockDecisionKind = 'none';
    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
    });
    expect(exitCode).toBe(0);
  } finally {
    process.exit = originalExit;
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue detects upgrade lock at profile root', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-upgrade');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    const profileCtx = buildProfileContext('prod');
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    await mkdir(profileCtx.configDir, { recursive: true });

    const lockPath = join(root, '.upgrade.lock');
    await writeFile(lockPath, 'lock');

    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    const inputObj = lastDecisionInput as { upgradeInProgress: boolean } | null;
    expect(inputObj).not.toBeNull();
    expect(inputObj?.upgradeInProgress).toBe(true);

    await rm(lockPath, { force: true });
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue consecutive failures logic: increments only if prior attempt exists, reset on healthy, unchanged on paused', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-consecutive');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);

    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    mockDecisionKind = 'start';
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    const bootId = await readBootId();
    let ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.consecutiveFailures).toBe(0);
    expect(ledger?.lastRescueAt).not.toBeNull();

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.consecutiveFailures).toBe(1);

    mockDecisionKind = 'paused';
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.consecutiveFailures).toBe(1);

    mockDecisionKind = 'none';
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.consecutiveFailures).toBe(0);

    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue persists capture and drain heartbeats in rescue ledger', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-hb-cover');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    mockHeartbeat = {
      captureLastCycleAt: '2026-06-16T12:00:00.000Z',
      drainLastCycleAt: '2026-06-16T11:00:00.000Z',
    };
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    let bootId = await readBootId();
    let ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.lastObservedCaptureAt).toBe('2026-06-16T12:00:00.000Z');
    expect(ledger?.lastObservedDrainAt).toBe('2026-06-16T11:00:00.000Z');

    mockHeartbeat = {
      captureLastCycleAt: '2026-06-16T11:00:00.000Z',
      drainLastCycleAt: '2026-06-16T12:00:00.000Z',
    };
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger?.lastObservedCaptureAt).toBe('2026-06-16T11:00:00.000Z');
    expect(ledger?.lastObservedDrainAt).toBe('2026-06-16T12:00:00.000Z');

    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
  } finally {
    mockHeartbeat = { captureLastCycleAt: null, drainLastCycleAt: null };
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('runRescue handles null ledger or invalid watchdog run time', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-cmd-test-null-ledger');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;

  try {
    const profileCtx = buildProfileContext('prod');
    await clearRescueLedger(profileCtx.sentinels.rescueLedger);
    const { spawn } = mockSpawn(() => ({ exitCode: 0 }));

    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });
    const bootId = await readBootId();
    let ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    const activeLedger = requireDefined(ledger);
    expect(activeLedger.lastWatchdogRunAt).not.toBeNull();

    activeLedger.lastWatchdogRunAt = null;
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, activeLedger);
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    const ledger2 = requireDefined(ledger);
    ledger2.lastWatchdogRunAt = 'invalid-date';
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, ledger2);
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    const ledger3 = requireDefined(ledger);
    ledger3.lastWatchdogRunAt = new Date().toISOString();
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, ledger3);
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    const ledger4 = requireDefined(ledger);
    const longAgo = new Date(Date.now() - 2 * 1800000).toISOString();
    ledger4.lastWatchdogRunAt = longAgo;
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, ledger4);
    await runRescue({
      profileName: 'prod',
      programPath: '/bin/gateway',
      platform: 'linux',
      spawn,
      skipExit: true,
    });

    ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);
    expect(ledger).not.toBeNull();
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});
