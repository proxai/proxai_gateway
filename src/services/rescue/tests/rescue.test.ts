import { expect, test, mock, afterEach } from 'bun:test';
import { join } from 'node:path';
import * as doctorQueries from 'services/buffer/doctor-queries.ts';
import {
  readRescueLedger,
  readRescueLedgerReadOnly,
  writeRescueLedger,
  clearRescueLedger,
  recordRescueAttempt,
  markDaemonHealthy,
  markRescueFailed,
  type RescueLedger,
} from 'services/rescue/rescue-ledger.ts';
import { decideRescue, type RescueDecisionInput } from 'services/rescue/rescue-decision.ts';
import { readHeartbeat } from 'services/rescue/heartbeat-read.ts';
import { sentinelHandle } from 'core/io/fs';

afterEach(() => {
  mock.restore();
});

test('rescue ledger CRUD and bootId mismatch handling', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-ledger-test');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;
  const ledgerPath = join(root, 'RESCUE_LEDGER');

  try {
    await clearRescueLedger(ledgerPath);

    const empty = await readRescueLedger(ledgerPath, 'boot-1');
    expect(empty).toBeNull();

    const initial: RescueLedger = {
      bootId: 'boot-1',
      lastRescueAt: '2026-06-16T12:00:00.000Z',
      consecutiveFailures: 1,
      attempts: [{ at: '2026-06-16T12:00:00.000Z', action: 'start' }],
    };

    await writeRescueLedger(ledgerPath, initial);

    const loaded = await readRescueLedger(ledgerPath, 'boot-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.bootId).toBe('boot-1');
    expect(loaded?.consecutiveFailures).toBe(1);
    expect(loaded?.attempts.length).toBe(1);

    const mismatched = await readRescueLedger(ledgerPath, 'boot-2');
    expect(mismatched).not.toBeNull();
    expect(mismatched?.bootId).toBe('boot-2');
    expect(mismatched?.consecutiveFailures).toBe(0);
    expect(mismatched?.attempts.length).toBe(0);
    expect(mismatched?.lastRescueAt).toBeNull();

    await clearRescueLedger(ledgerPath);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('rescue ledger helpers', () => {
  const ledger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: null,
    consecutiveFailures: 0,
    attempts: [],
  };

  recordRescueAttempt(ledger, '2026-06-16T12:00:00.000Z', 'start');
  expect(ledger.lastRescueAt).toBe('2026-06-16T12:00:00.000Z');
  expect(ledger.attempts.length).toBe(1);
  expect(ledger.attempts[0]?.action).toBe('start');

  for (let i = 0; i < 25; i++) {
    recordRescueAttempt(ledger, `time-${i}`, 'restart');
  }
  expect(ledger.attempts.length).toBe(20);
  expect(ledger.attempts[19]?.at).toBe('time-24');

  markRescueFailed(ledger);
  expect(ledger.consecutiveFailures).toBe(1);

  markDaemonHealthy(ledger);
  expect(ledger.consecutiveFailures).toBe(0);
});

test('decideRescue transitions', () => {
  const baseInput: RescueDecisionInput = {
    configExists: true,
    serviceUnitRegistered: true,
    isRunning: true,
    captureLastCycleAt: '2026-06-16T12:00:00.000Z',
    drainLastCycleAt: '2026-06-16T12:00:00.000Z',
    authFailedPresent: false,
    bufferFullPresent: false,
    sessionStoppedThisBoot: false,
    upgradeInProgress: false,
    ledger: null,
    now: new Date('2026-06-16T12:05:00.000Z'),
  };

  expect(decideRescue({ ...baseInput, configExists: false })).toEqual({
    kind: 'none',
    reason: 'not-configured',
  });

  expect(decideRescue({ ...baseInput, serviceUnitRegistered: false })).toEqual({
    kind: 'none',
    reason: 'not-registered',
  });

  expect(decideRescue({ ...baseInput, sessionStoppedThisBoot: true })).toEqual({
    kind: 'none',
    reason: 'user-stopped',
  });

  expect(decideRescue({ ...baseInput, upgradeInProgress: true })).toEqual({
    kind: 'none',
    reason: 'upgrading',
  });

  const brokenLedger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: null,
    consecutiveFailures: 3,
    attempts: [],
  };
  expect(decideRescue({ ...baseInput, ledger: brokenLedger })).toEqual({
    kind: 'none',
    reason: 'circuit-broken',
  });

  const cappedLedger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: '2026-06-16T12:03:00.000Z',
    consecutiveFailures: 0,
    attempts: [],
  };
  expect(decideRescue({ ...baseInput, ledger: cappedLedger })).toEqual({
    kind: 'none',
    reason: 'rate-capped',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: null,
      drainLastCycleAt: null,
    }),
  ).toEqual({
    kind: 'start',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: '2026-06-16T11:40:00.000Z',
      drainLastCycleAt: '2026-06-16T11:40:00.000Z',
    }),
  ).toEqual({
    kind: 'start',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: '2026-06-16T12:04:00.000Z',
      drainLastCycleAt: '2026-06-16T12:04:00.000Z',
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(decideRescue({ ...baseInput, isRunning: true, authFailedPresent: true })).toEqual({
    kind: 'none',
    reason: 'paused',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: true,
      captureLastCycleAt: '2026-06-16T11:30:00.000Z',
      drainLastCycleAt: '2026-06-16T11:30:00.000Z',
    }),
  ).toEqual({
    kind: 'restart',
  });

  const oldRescueLedger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: '2026-06-16T10:00:00.000Z',
    consecutiveFailures: 0,
    attempts: [],
  };
  expect(
    decideRescue({
      ...baseInput,
      ledger: oldRescueLedger,
      isRunning: false,
      captureLastCycleAt: null,
      drainLastCycleAt: null,
    }),
  ).toEqual({
    kind: 'start',
  });

  const invalidRescueLedger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: 'invalid-date',
    consecutiveFailures: 0,
    attempts: [],
  };
  expect(
    decideRescue({
      ...baseInput,
      ledger: invalidRescueLedger,
      isRunning: false,
      captureLastCycleAt: null,
      drainLastCycleAt: null,
    }),
  ).toEqual({
    kind: 'start',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: '2026-06-16T12:04:00.000Z',
      drainLastCycleAt: '2026-06-16T12:03:00.000Z',
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: '2026-06-16T11:30:00.000Z',
      drainLastCycleAt: '2026-06-16T11:31:00.000Z',
    }),
  ).toEqual({
    kind: 'start',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: true,
      captureLastCycleAt: null,
      drainLastCycleAt: null,
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: true,
      captureLastCycleAt: 'invalid-date',
      drainLastCycleAt: null,
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: true,
      captureLastCycleAt: null,
      drainLastCycleAt: 'invalid-date',
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  const clockSkewLedger: RescueLedger = {
    bootId: 'boot-1',
    lastRescueAt: '2026-06-16T12:10:00.000Z',
    consecutiveFailures: 0,
    attempts: [],
  };
  expect(
    decideRescue({
      ...baseInput,
      ledger: clockSkewLedger,
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: false,
      captureLastCycleAt: null,
      drainLastCycleAt: '2026-06-16T12:04:00.000Z',
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });

  expect(
    decideRescue({
      ...baseInput,
      isRunning: true,
      captureLastCycleAt: null,
      drainLastCycleAt: '2026-06-16T12:04:00.000Z',
    }),
  ).toEqual({
    kind: 'none',
    reason: 'healthy',
  });
});

let useMockDoctorQueries = false;

const originalExports = {
  queryDoctorBufferStats: doctorQueries.queryDoctorBufferStats,
  queryDoctorDaemonState: doctorQueries.queryDoctorDaemonState,
  queryDoctorRecentEvents: doctorQueries.queryDoctorRecentEvents,
  queryDoctorResyncStats: doctorQueries.queryDoctorResyncStats,
  queryDoctorCaptureErrors: doctorQueries.queryDoctorCaptureErrors,
  tableExists: doctorQueries.tableExists,
  checkReceiptsTableReadable: doctorQueries.checkReceiptsTableReadable,
  queryAllDoctorData: doctorQueries.queryAllDoctorData,
};

mock.module('services/buffer/doctor-queries.ts', () => {
  return {
    ...originalExports,
    queryAllDoctorData: (path: string) => {
      if (path === 'throw') {
        throw new Error('mock error');
      }
      if (useMockDoctorQueries) {
        return {
          bufferStats: {
            pendingCount: 0,
            pendingBytes: 0,
            failedCount: 0,
            quarantinedCount: 0,
            receiptCount: 0,
            lastPruneAt: null,
            lastSuccessAt: null,
          },
          daemonState: {
            captureLastCycleAt: 'cap-time',
            drainLastCycleAt: 'drain-time',
            lastConsecutiveRetriableBreak: null,
            lastUploadError: null,
          },
          recentEvents: {
            authUnconfirmedCount: 0,
            rateLimitedCount: 0,
            retriableCount: 0,
            fatalValidationErrorCount: 0,
            autoUpgradeEvents: [],
          },
          resyncStats: {
            totalCount: 0,
            regressionLoops: [],
          },
          captureErrors: [],
          dbReadable: true,
          receiptsTableReadable: true,
        };
      }
      return originalExports.queryAllDoctorData(path);
    },
  };
});

test('readHeartbeat integrates queryAllDoctorData', () => {
  useMockDoctorQueries = true;
  try {
    const hb = readHeartbeat('/db/path');
    expect(hb.captureLastCycleAt).toBe('cap-time');
    expect(hb.drainLastCycleAt).toBe('drain-time');
  } finally {
    useMockDoctorQueries = false;
  }
});

test('readHeartbeat returns nulls when queryAllDoctorData throws', () => {
  const hb = readHeartbeat('throw');
  expect(hb.captureLastCycleAt).toBeNull();
  expect(hb.drainLastCycleAt).toBeNull();
});

test('readRescueLedger returns null on invalid JSON', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-ledger-invalid-json-test');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;
  const ledgerPath = join(root, 'RESCUE_LEDGER');

  try {
    await clearRescueLedger(ledgerPath);
    await sentinelHandle(ledgerPath).write('{ malformed json');

    const result = await readRescueLedger(ledgerPath, 'boot-1');
    expect(result).toBeNull();
  } finally {
    await clearRescueLedger(ledgerPath);
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('readRescueLedgerReadOnly behaviour', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const root = join('/tmp', 'proxai-rescue-ledger-ro-test');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = root;
  const ledgerPath = join(root, 'RESCUE_LEDGER');

  try {
    await clearRescueLedger(ledgerPath);

    const r1 = await readRescueLedgerReadOnly(ledgerPath, 'boot-1');
    expect(r1).toBeNull();

    await sentinelHandle(ledgerPath).write('{ malformed json');
    const r2 = await readRescueLedgerReadOnly(ledgerPath, 'boot-1');
    expect(r2).toBeNull();

    const initial: RescueLedger = {
      bootId: 'boot-1',
      lastRescueAt: '2026-06-16T12:00:00.000Z',
      consecutiveFailures: 2,
      attempts: [],
    };
    await writeRescueLedger(ledgerPath, initial);

    const r3 = await readRescueLedgerReadOnly(ledgerPath, 'boot-1');
    expect(r3).not.toBeNull();
    expect(r3?.bootId).toBe('boot-1');
    expect(r3?.consecutiveFailures).toBe(2);

    const r4 = await readRescueLedgerReadOnly(ledgerPath, 'boot-2');
    expect(r4).not.toBeNull();
    expect(r4?.bootId).toBe('boot-2');
    expect(r4?.consecutiveFailures).toBe(0);

    const r5 = await readRescueLedgerReadOnly(ledgerPath, 'boot-1');
    expect(r5?.bootId).toBe('boot-1');
    expect(r5?.consecutiveFailures).toBe(2);

    await clearRescueLedger(ledgerPath);
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});
