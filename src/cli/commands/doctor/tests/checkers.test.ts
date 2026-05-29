import { expect, test } from 'bun:test';

import { requireDefined } from 'core/utils';
import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals } from 'cli/commands/doctor/doctor.types.ts';
import {
  checkA1NotSetUp,
  checkA2UnitNotRegistered,
  checkA3StoppedByUser,
  checkA4Crashed,
  checkA5Wedged,
} from 'cli/commands/doctor/checkers/lifecycle.ts';
import {
  checkB1InvalidKey,
  checkB2AuthUnconfirmedLoop,
  checkB3IngestionKeyAuthError,
} from 'cli/commands/doctor/checkers/auth.ts';
import {
  checkC1RateLimited,
  checkC2NetworkFailure,
  checkC3DrainWedged,
  checkC4BufferRecovery,
  checkC5BufferOscillating,
  checkC6ParserValidationErrors,
  checkC7QuarantinedRows,
} from 'cli/commands/doctor/checkers/upload.ts';
import {
  checkD1NoAgentActivity,
  checkD2OneSourceErroring,
} from 'cli/commands/doctor/checkers/capture.ts';
import {
  checkE1StaleBinary,
  checkE2BrewUpdatePending,
  checkE3WriteFailed,
  checkE4SuccessOldVersionRunning,
} from 'cli/commands/doctor/checkers/binary.ts';
import {
  checkF1ConfigDirNotWritable,
  checkF2DiskSpaceLow,
  checkF3LogDirNotWritable,
  checkF4ClockSkew,
  checkF5LinuxNoLinger,
  checkF6WindowsUserUnresolvable,
  checkF7MacOsQuarantine,
} from 'cli/commands/doctor/checkers/filesystem.ts';
import {
  checkG1ReceiptsTableReadable,
  checkG2BufferDbCorrupt,
  checkG3RegressionLoop,
} from 'cli/commands/doctor/checkers/data-integrity.ts';

const MS_PER_DAY = 86_400_000;

function baseSignals(overrides: Partial<DoctorSignals> = {}): DoctorSignals {
  const base: DoctorSignals = {
    configExists: true,
    configParses: true,
    apiKeyPresent: true,
    serviceUnitRegistered: true,
    daemonRunning: true,
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    buffer: {
      pendingCount: 0,
      pendingBytes: 0,
      failedCount: 0,
      quarantinedCount: 0,
      receiptCount: 1,
      lastPruneAt: null,
      lastSuccessAt: null,
    },
    daemonState: {
      captureLastCycleAt: new Date().toISOString(),
      drainLastCycleAt: new Date().toISOString(),
      lastConsecutiveRetriableBreak: false,
      lastUploadError: null,
    },
    binary: {
      version: '2026.5.28',
      mtime: new Date(),
      installSource: 'npm',
    },
    recentEvents: {
      authUnconfirmedCount: 0,
      rateLimitedCount: 0,
      retriableCount: 0,
      fatalValidationErrorCount: 0,
      autoUpgradeEvents: [],
    },
    filesystem: {
      configDirWritable: true,
      logDirWritable: true,
      diskFreeBytes: null,
    },
    network: {
      nestReachable: true,
    },
    sourcePaths: {
      claudeCodeExists: true,
      cursorExists: false,
      codexExists: false,
      geminiCliExists: false,
    },
    resyncEvents: {
      totalCount: 0,
      regressionLoops: [],
    },
    platform: 'linux',
    systemdLingerEnabled: true,
    macOsQuarantineXattr: null,
    clockSkewMs: null,
    bufferDbReadable: true,
    receiptsTableReadable: true,
  };
  return { ...base, ...overrides };
}

function withSentinels(over: Partial<DoctorSignals['sentinels']>): DoctorSignals {
  return baseSignals({ sentinels: { ...baseSignals().sentinels, ...over } });
}

function withBuffer(over: Partial<DoctorSignals['buffer']>): DoctorSignals {
  return baseSignals({ buffer: { ...baseSignals().buffer, ...over } });
}

function withEvents(over: Partial<DoctorSignals['recentEvents']>): DoctorSignals {
  return baseSignals({ recentEvents: { ...baseSignals().recentEvents, ...over } });
}

function withFs(over: Partial<DoctorSignals['filesystem']>): DoctorSignals {
  return baseSignals({ filesystem: { ...baseSignals().filesystem, ...over } });
}

function withDaemonState(over: Partial<DoctorSignals['daemonState']>): DoctorSignals {
  return baseSignals({ daemonState: { ...baseSignals().daemonState, ...over } });
}

function withBinary(over: Partial<DoctorSignals['binary']>): DoctorSignals {
  return baseSignals({ binary: { ...baseSignals().binary, ...over } });
}

test('A1: returns null when config exists, finding when absent', () => {
  expect(checkA1NotSetUp(baseSignals({ configExists: true }))).toBeNull();
  const f = requireDefined(checkA1NotSetUp(baseSignals({ configExists: false })));
  expect(f.code).toBe('A1');
  expect(f.severity).toBe(Severity.critical);
  expect(f.confidence).toBe(Confidence.confirmed);
});

test('A2: null when config absent, null when registered, finding when present-but-unregistered', () => {
  expect(checkA2UnitNotRegistered(baseSignals({ configExists: false }))).toBeNull();
  expect(checkA2UnitNotRegistered(baseSignals({ serviceUnitRegistered: true }))).toBeNull();
  const f = requireDefined(
    checkA2UnitNotRegistered(baseSignals({ configExists: true, serviceUnitRegistered: false })),
  );
  expect(f.code).toBe('A2');
});

test('A3: stopped-by-user requires config + registered + not-running + sessionStopped', () => {
  expect(checkA3StoppedByUser(baseSignals({ configExists: false }))).toBeNull();
  expect(checkA3StoppedByUser(baseSignals({ serviceUnitRegistered: false }))).toBeNull();
  expect(checkA3StoppedByUser(baseSignals({ daemonRunning: true }))).toBeNull();
  expect(
    checkA3StoppedByUser(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA3StoppedByUser(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: true },
      }),
    ),
  );
  expect(f.code).toBe('A3');
  expect(f.severity).toBe(Severity.warning);
});

test('A4: crash requires config + registered + not-running + NO sessionStopped', () => {
  expect(checkA4Crashed(baseSignals({ configExists: false }))).toBeNull();
  expect(checkA4Crashed(baseSignals({ serviceUnitRegistered: false }))).toBeNull();
  expect(checkA4Crashed(baseSignals({ daemonRunning: true }))).toBeNull();
  expect(
    checkA4Crashed(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: true },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA4Crashed(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: false },
      }),
    ),
  );
  expect(f.code).toBe('A4');
  expect(f.confidence).toBe(Confidence.likely);
});

test('A5: wedged daemon detection', () => {
  expect(checkA5Wedged(baseSignals({ daemonRunning: false }))).toBeNull();
  expect(checkA5Wedged(withDaemonState({ captureLastCycleAt: null }))).toBeNull();
  expect(checkA5Wedged(withDaemonState({ captureLastCycleAt: 'not-a-date' }))).toBeNull();
  expect(
    checkA5Wedged(withDaemonState({ captureLastCycleAt: new Date().toISOString() })),
  ).toBeNull();
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const f = requireDefined(checkA5Wedged(withDaemonState({ captureLastCycleAt: stale })));
  expect(f.code).toBe('A5');
});

test('B1: AUTH_FAILED sentinel flags invalid key', () => {
  expect(checkB1InvalidKey(withSentinels({ authFailed: false }))).toBeNull();
  const f = requireDefined(checkB1InvalidKey(withSentinels({ authFailed: true })));
  expect(f.code).toBe('B1');
  expect(f.severity).toBe(Severity.critical);
});

test('B2: auth-unconfirmed loop only when NO AUTH_FAILED and count>0', () => {
  expect(checkB2AuthUnconfirmedLoop(withSentinels({ authFailed: true }))).toBeNull();
  expect(checkB2AuthUnconfirmedLoop(withEvents({ authUnconfirmedCount: 0 }))).toBeNull();
  const f = requireDefined(
    checkB2AuthUnconfirmedLoop(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, authFailed: false },
        recentEvents: { ...baseSignals().recentEvents, authUnconfirmedCount: 3 },
      }),
    ),
  );
  expect(f.code).toBe('B2');
  expect(f.cause).toContain('API key network verification');
});

test('B3: ingestion key authentication error based on lastUploadError', () => {
  expect(checkB3IngestionKeyAuthError(withDaemonState({ lastUploadError: null }))).toBeNull();
  expect(
    checkB3IngestionKeyAuthError(withDaemonState({ lastUploadError: 'some other error' })),
  ).toBeNull();

  const f1 = requireDefined(
    checkB3IngestionKeyAuthError(withDaemonState({ lastUploadError: 'HTTP 403 Forbidden' })),
  );
  expect(f1.code).toBe('B3');
  expect(f1.severity).toBe(Severity.critical);
  expect(f1.confidence).toBe(Confidence.confirmed);

  const f2 = requireDefined(
    checkB3IngestionKeyAuthError(
      withDaemonState({ lastUploadError: 'invalid ingestion key provided' }),
    ),
  );
  expect(f2.code).toBe('B3');
  expect(f2.severity).toBe(Severity.critical);
});

test('C1: rate-limited detection', () => {
  expect(checkC1RateLimited(withEvents({ rateLimitedCount: 0 }))).toBeNull();
  const f = requireDefined(checkC1RateLimited(withEvents({ rateLimitedCount: 5 })));
  expect(f.code).toBe('C1');
});

test('C2: network failure only when reachable=false, no auth-fail, no rate-limit', () => {
  expect(checkC2NetworkFailure(baseSignals({ network: { nestReachable: true } }))).toBeNull();
  expect(checkC2NetworkFailure(baseSignals({ network: { nestReachable: null } }))).toBeNull();
  expect(
    checkC2NetworkFailure(
      baseSignals({
        network: { nestReachable: false },
        sentinels: { ...baseSignals().sentinels, authFailed: true },
      }),
    ),
  ).toBeNull();
  expect(
    checkC2NetworkFailure(
      baseSignals({
        network: { nestReachable: false },
        recentEvents: { ...baseSignals().recentEvents, rateLimitedCount: 1 },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC2NetworkFailure(baseSignals({ network: { nestReachable: false } })),
  );
  expect(f.code).toBe('C2');
});

test('C3: drain wedged with pending batches and no gating sentinel', () => {
  expect(checkC3DrainWedged(baseSignals({ daemonRunning: false }))).toBeNull();
  expect(checkC3DrainWedged(withBuffer({ pendingCount: 0 }))).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        sentinels: { ...baseSignals().sentinels, authFailed: true },
      }),
    ),
  ).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
      }),
    ),
  ).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        network: { nestReachable: false },
      }),
    ),
  ).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: null },
      }),
    ),
  ).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: 'bad' },
      }),
    ),
  ).toBeNull();
  expect(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        daemonState: {
          ...baseSignals().daemonState,
          drainLastCycleAt: new Date().toISOString(),
        },
      }),
    ),
  ).toBeNull();
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const f = requireDefined(
    checkC3DrainWedged(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 1 },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: stale },
      }),
    ),
  );
  expect(f.code).toBe('C3');
});

test('C4: buffer recovery in progress when BUFFER_FULL active but drain advancing', () => {
  expect(checkC4BufferRecovery(withSentinels({ bufferFull: false }))).toBeNull();
  expect(
    checkC4BufferRecovery(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: null },
      }),
    ),
  ).toBeNull();
  expect(
    checkC4BufferRecovery(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: 'bad' },
      }),
    ),
  ).toBeNull();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  expect(
    checkC4BufferRecovery(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: old },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC4BufferRecovery(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: {
          ...baseSignals().daemonState,
          drainLastCycleAt: new Date().toISOString(),
        },
      }),
    ),
  );
  expect(f.code).toBe('C4');
  expect(f.severity).toBe(Severity.info);
});

test('C5: buffer oscillating', () => {
  expect(checkC5BufferOscillating(withBuffer({ pendingBytes: 0 }))).toBeNull();
  expect(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100 },
        sentinels: { ...baseSignals().sentinels, bufferFull: false },
      }),
    ),
  ).toBeNull();
  expect(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: null },
      }),
    ),
  ).toBeNull();
  expect(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: 'bad' },
      }),
    ),
  ).toBeNull();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  expect(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: { ...baseSignals().daemonState, drainLastCycleAt: old },
      }),
    ),
  ).toBeNull();
  expect(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100, pendingCount: 1 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: {
          ...baseSignals().daemonState,
          drainLastCycleAt: new Date().toISOString(),
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC5BufferOscillating(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingBytes: 100, pendingCount: 5 },
        sentinels: { ...baseSignals().sentinels, bufferFull: true },
        daemonState: {
          ...baseSignals().daemonState,
          drainLastCycleAt: new Date().toISOString(),
        },
      }),
    ),
  );
  expect(f.code).toBe('C5');
});

test('C6: parser validation errors', () => {
  expect(checkC6ParserValidationErrors(withEvents({ fatalValidationErrorCount: 0 }))).toBeNull();
  const f = requireDefined(
    checkC6ParserValidationErrors(withEvents({ fatalValidationErrorCount: 2 })),
  );
  expect(f.code).toBe('C6');
  expect(f.severity).toBe(Severity.critical);
});

test('C7: quarantined rows', () => {
  expect(checkC7QuarantinedRows(withBuffer({ quarantinedCount: 0 }))).toBeNull();
  const f = requireDefined(checkC7QuarantinedRows(withBuffer({ quarantinedCount: 4 })));
  expect(f.code).toBe('C7');
  expect(f.cause).toContain('4 oversized');
});

test('D1: no agent activity, info when source dirs exist', () => {
  expect(checkD1NoAgentActivity(baseSignals({ daemonRunning: false }))).toBeNull();
  expect(checkD1NoAgentActivity(withBuffer({ pendingCount: 1, receiptCount: 0 }))).toBeNull();
  expect(checkD1NoAgentActivity(withBuffer({ pendingCount: 0, receiptCount: 1 }))).toBeNull();
  const info = requireDefined(
    checkD1NoAgentActivity(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 0, receiptCount: 0 },
        sourcePaths: {
          claudeCodeExists: true,
          cursorExists: false,
          codexExists: false,
          geminiCliExists: false,
        },
      }),
    ),
  );
  expect(info.code).toBe('D1');
  expect(info.severity).toBe(Severity.info);
});

test('D1: warning when no source dirs exist at all', () => {
  const warn = requireDefined(
    checkD1NoAgentActivity(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 0, receiptCount: 0 },
        sourcePaths: {
          claudeCodeExists: false,
          cursorExists: false,
          codexExists: false,
          geminiCliExists: false,
        },
      }),
    ),
  );
  expect(warn.code).toBe('D1');
  expect(warn.severity).toBe(Severity.warning);
});

test('D2: one source erroring on retriable events with empty buffer', () => {
  expect(
    checkD2OneSourceErroring(withEvents({ retriableCount: 0, fatalValidationErrorCount: 0 })),
  ).toBeNull();
  expect(
    checkD2OneSourceErroring(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, retriableCount: 2 },
        buffer: { ...baseSignals().buffer, pendingCount: 1, receiptCount: 0 },
      }),
    ),
  ).toBeNull();
  expect(
    checkD2OneSourceErroring(
      baseSignals({
        recentEvents: {
          ...baseSignals().recentEvents,
          retriableCount: 2,
          fatalValidationErrorCount: 1,
        },
        buffer: { ...baseSignals().buffer, pendingCount: 0, receiptCount: 0 },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkD2OneSourceErroring(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, retriableCount: 2 },
        buffer: { ...baseSignals().buffer, pendingCount: 0, receiptCount: 0 },
      }),
    ),
  );
  expect(f.code).toBe('D2');
});

test('E1: stale binary requires mtime, non-brew, age>=60d, and an upgrade-failure event', () => {
  expect(checkE1StaleBinary(withBinary({ mtime: null }))).toBeNull();
  expect(checkE1StaleBinary(withBinary({ installSource: 'brew' }))).toBeNull();
  const oldMtime = new Date(Date.now() - 100 * MS_PER_DAY);
  expect(checkE1StaleBinary(withBinary({ mtime: new Date(), installSource: 'npm' }))).toBeNull();
  expect(
    checkE1StaleBinary(
      baseSignals({
        binary: { ...baseSignals().binary, mtime: oldMtime, installSource: 'npm' },
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['some_other_event'] },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkE1StaleBinary(
      baseSignals({
        binary: { ...baseSignals().binary, mtime: oldMtime, installSource: 'npm' },
        recentEvents: {
          ...baseSignals().recentEvents,
          autoUpgradeEvents: ['auto_upgrade download_failed boom'],
        },
      }),
    ),
  );
  expect(f.code).toBe('E1');
  expect(f.cause).toContain('download_failed');
});

test('E1: falls back to generic cause when find returns undefined despite some-match', () => {
  const oldMtime = new Date(Date.now() - 100 * MS_PER_DAY);
  const f = requireDefined(
    checkE1StaleBinary(
      baseSignals({
        binary: { ...baseSignals().binary, mtime: oldMtime, installSource: 'npm' },
        recentEvents: {
          ...baseSignals().recentEvents,
          autoUpgradeEvents: ['check_failed'],
        },
      }),
    ),
  );
  expect(f.cause).toContain('check_failed');
});

test('E2: brew update pending only when sentinel present and install_source=brew', () => {
  expect(checkE2BrewUpdatePending(withSentinels({ updateAvailable: false }))).toBeNull();
  expect(
    checkE2BrewUpdatePending(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, updateAvailable: true },
        binary: { ...baseSignals().binary, installSource: 'npm' },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkE2BrewUpdatePending(
      baseSignals({
        sentinels: { ...baseSignals().sentinels, updateAvailable: true },
        binary: { ...baseSignals().binary, installSource: 'brew' },
      }),
    ),
  );
  expect(f.code).toBe('E2');
  expect(f.severity).toBe(Severity.info);
});

test('E3: write_failed disambiguated by disk-full, then config-dir, then unclear', () => {
  expect(checkE3WriteFailed(withEvents({ autoUpgradeEvents: [] }))).toBeNull();

  const diskFull = requireDefined(
    checkE3WriteFailed(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['write_failed'] },
        filesystem: { ...baseSignals().filesystem, diskFreeBytes: 10 * 1024 * 1024 },
      }),
    ),
  );
  expect(diskFull.cause).toContain('disk is nearly full');
  expect(diskFull.confidence).toBe(Confidence.confirmed);

  const permMismatch = requireDefined(
    checkE3WriteFailed(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['write_failed'] },
        filesystem: {
          ...baseSignals().filesystem,
          diskFreeBytes: 500 * 1024 * 1024,
          configDirWritable: false,
        },
      }),
    ),
  );
  expect(permMismatch.cause).toContain('not writable');

  const unclear = requireDefined(
    checkE3WriteFailed(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['write_failed'] },
        filesystem: {
          ...baseSignals().filesystem,
          diskFreeBytes: null,
          configDirWritable: true,
        },
      }),
    ),
  );
  expect(unclear.confidence).toBe(Confidence.likely);
  expect(unclear.cause).toContain('write error');
});

test('E4: success but old binary mtime suggests no clean restart', () => {
  expect(checkE4SuccessOldVersionRunning(withEvents({ autoUpgradeEvents: [] }))).toBeNull();
  expect(
    checkE4SuccessOldVersionRunning(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['upgrade success'] },
        binary: { ...baseSignals().binary, mtime: null },
      }),
    ),
  ).toBeNull();
  expect(
    checkE4SuccessOldVersionRunning(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['upgrade success'] },
        binary: { ...baseSignals().binary, mtime: new Date() },
      }),
    ),
  ).toBeNull();
  const oldMtime = new Date(Date.now() - 10 * 60 * 1000);
  const f = requireDefined(
    checkE4SuccessOldVersionRunning(
      baseSignals({
        recentEvents: { ...baseSignals().recentEvents, autoUpgradeEvents: ['upgrade success'] },
        binary: { ...baseSignals().binary, mtime: oldMtime },
      }),
    ),
  );
  expect(f.code).toBe('E4');
});

test('F1: config dir not writable', () => {
  expect(checkF1ConfigDirNotWritable(withFs({ configDirWritable: true }))).toBeNull();
  const f = requireDefined(checkF1ConfigDirNotWritable(withFs({ configDirWritable: false })));
  expect(f.code).toBe('F1');
});

test('F2: disk space low', () => {
  expect(checkF2DiskSpaceLow(withFs({ diskFreeBytes: null }))).toBeNull();
  expect(checkF2DiskSpaceLow(withFs({ diskFreeBytes: 600 * 1024 * 1024 }))).toBeNull();
  const f = requireDefined(checkF2DiskSpaceLow(withFs({ diskFreeBytes: 100 * 1024 * 1024 })));
  expect(f.code).toBe('F2');
  expect(f.cause).toContain('100 MiB');
});

test('F3: log dir not writable', () => {
  expect(checkF3LogDirNotWritable(withFs({ logDirWritable: true }))).toBeNull();
  const f = requireDefined(checkF3LogDirNotWritable(withFs({ logDirWritable: false })));
  expect(f.code).toBe('F3');
});

test('F4: clock skew warning', () => {
  expect(checkF4ClockSkew(baseSignals({ clockSkewMs: null }))).toBeNull();
  expect(checkF4ClockSkew(baseSignals({ clockSkewMs: 1000 }))).toBeNull();
  const f = requireDefined(checkF4ClockSkew(baseSignals({ clockSkewMs: -10 * 60 * 1000 })));
  expect(f.code).toBe('F4');
  expect(f.cause).toContain('10 min');
});

test('F5: linux no-linger', () => {
  expect(checkF5LinuxNoLinger(baseSignals({ platform: 'darwin' }))).toBeNull();
  expect(
    checkF5LinuxNoLinger(baseSignals({ platform: 'linux', systemdLingerEnabled: null })),
  ).toBeNull();
  expect(
    checkF5LinuxNoLinger(baseSignals({ platform: 'linux', systemdLingerEnabled: true })),
  ).toBeNull();
  const f = requireDefined(
    checkF5LinuxNoLinger(baseSignals({ platform: 'linux', systemdLingerEnabled: false })),
  );
  expect(f.code).toBe('F5');
});

test('F6: windows user unresolvable returns null on both branches', () => {
  expect(checkF6WindowsUserUnresolvable(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkF6WindowsUserUnresolvable(baseSignals({ platform: 'win32', systemdLingerEnabled: true })),
  ).toBeNull();
  expect(
    checkF6WindowsUserUnresolvable(baseSignals({ platform: 'win32', systemdLingerEnabled: null })),
  ).toBeNull();
});

test('F7: macos quarantine xattr', () => {
  expect(checkF7MacOsQuarantine(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkF7MacOsQuarantine(baseSignals({ platform: 'darwin', macOsQuarantineXattr: null })),
  ).toBeNull();
  expect(
    checkF7MacOsQuarantine(baseSignals({ platform: 'darwin', macOsQuarantineXattr: false })),
  ).toBeNull();
  const f = requireDefined(
    checkF7MacOsQuarantine(baseSignals({ platform: 'darwin', macOsQuarantineXattr: true })),
  );
  expect(f.code).toBe('F7');
  expect(f.severity).toBe(Severity.critical);
});

test('G1: receipts-table-readable returns null when readable, finding when unreadable', () => {
  expect(checkG1ReceiptsTableReadable(baseSignals({ receiptsTableReadable: true }))).toBeNull();
  const f = requireDefined(
    checkG1ReceiptsTableReadable(baseSignals({ receiptsTableReadable: false })),
  );
  expect(f.code).toBe('G1');
  expect(f.severity).toBe(Severity.critical);
});

test('G2: buffer-db-corrupt returns null when readable, finding when unreadable', () => {
  expect(checkG2BufferDbCorrupt(baseSignals({ bufferDbReadable: true }))).toBeNull();
  const f = requireDefined(checkG2BufferDbCorrupt(baseSignals({ bufferDbReadable: false })));
  expect(f.code).toBe('G2');
  expect(f.severity).toBe(Severity.critical);
});

test('G3: regression loop above threshold', () => {
  expect(
    checkG3RegressionLoop(
      baseSignals({
        resyncEvents: {
          totalCount: 1,
          regressionLoops: [{ sourcePathHash: 'abc', countInLastHour: 2 }],
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG3RegressionLoop(
      baseSignals({
        resyncEvents: {
          totalCount: 10,
          regressionLoops: [
            { sourcePathHash: 'deadbeefcafe', countInLastHour: 5 },
            { sourcePathHash: 'feedface0000', countInLastHour: 8 },
          ],
        },
      }),
    ),
  );
  expect(f.code).toBe('G3');
  expect(f.cause).toContain('deadbeef');
  expect(f.cause).toContain('8 regressions');
});
