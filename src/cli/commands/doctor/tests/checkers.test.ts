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
  checkD3SourceCaptureErrors,
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

import {
  checkG4JournalMode,
  checkG5BusyTimeout,
  checkG6TransactionLockup,
  checkG7WalCheckpointStarvation,
  checkG8UncommittedJournalStaleLock,
} from 'cli/commands/doctor/checkers/concurrency.ts';
import {
  checkB4InsecureApiKeyTransmission,
  checkB5PermissiveConfigPermissions,
  checkB6OverlyBroadDirectoryWatches,
} from 'cli/commands/doctor/checkers/security.ts';
import {
  checkF17V8SyncEventLoopLag,
  checkF18V8HeapExhaustion,
  checkG10CompressionSpikes,
} from 'cli/commands/doctor/checkers/performance.ts';
import {
  checkC8OutboundTlsInspection,
  checkC9GlobalProxyMismatch,
  checkC10DnsHijackCaptivePortal,
  checkC11ThrottlerResetSkew,
  checkC12ThunderingHerdJitter,
  checkC13OutboxTimeout,
} from 'cli/commands/doctor/checkers/network.ts';
import {
  checkA13SystemdRuntimeDirMissing,
  checkA14SystemdRateLimitHit,
  checkA15SystemdHomeEncryptedTearing,
} from 'cli/commands/doctor/checkers/systemd.ts';
import {
  checkA11WindowsServiceUnquotedPath,
  checkA12WindowsTaskSchedulerXmlCorrupt,
} from 'cli/commands/doctor/checkers/windows.ts';
import {
  checkA6AbruptDaemonTermination,
  checkA7ZombieDaemon,
  checkA8GracefulTerminationLockup,
  checkA9HelperProcessHealthy,
  checkA10ThreadWatcherExhaustion,
} from 'cli/commands/doctor/checkers/stray-daemon.ts';
import { checkE7HomebrewRelocationDrift } from 'cli/commands/doctor/checkers/path-drift.ts';
import {
  checkE5UpgradeLockStale,
  checkE6CorruptedUpgradeBinary,
} from 'cli/commands/doctor/checkers/upgrade-lock.ts';
import {
  checkF8MacOsTccFDA,
  checkF9MacOsGatekeeperTranslocation,
  checkF10SandboxedTerminalLocks,
  checkF11SymlinkTraversalLoop,
  checkF12POSIXExtendedAclBlocked,
  checkF13BrokenWindowsJunction,
  checkF14LogRotationInodeDrift,
  checkF15PhysicalWriteExhaustion,
  checkF16SudoHijackOwnershipDrift,
} from 'cli/commands/doctor/checkers/advanced-fs.ts';
import { checkG9InconsistentSessionUuids } from 'cli/commands/doctor/checkers/data-extended.ts';

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
      authFailedRetryAttempts: 0,
      authFailedRetryMax: 0,
      authFailedRetryExhausted: false,
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
      claudeDesktopExists: false,
      geminiExists: false,
    },
    resyncEvents: {
      totalCount: 0,
      regressionLoops: [],
    },
    captureErrors: [],
    platform: 'linux',
    systemdLingerEnabled: true,
    macOsQuarantineXattr: null,
    clockSkewMs: null,
    bufferDbReadable: true,
    receiptsTableReadable: true,
    clockExtended: {
      localTimeOffsetMinute: 0,
      timezone: 'UTC',
    },
    processExtended: {
      controlSocketExists: false,
      controlSocketActive: false,
      zombieProcessesDetected: false,
      zombieProcessPids: [],
      helperProcessHealthy: true,
      watcherThreadLagMs: 0,
    },
    securityExtended: {
      configUnescapedBackslashes: false,
      configObsoleteKeys: [],
      configValueConstraintsViolated: false,
    },
    networkExtended: {
      tlsInspectionDetected: false,
      tlsInspectionIssuer: null,
      globalProxyMismatch: false,
      dnsHijackOrCaptivePortal: false,
    },
    filesystemExtended: {
      symlinkLoopDetected: false,
      aclWriteBlocked: false,
      brokenWindowsJunctions: [],
      writeProbeSuccess: true,
      writeProbeError: null,
      sudoOwnershipDrift: false,
      logInodeDriftDetected: false,
    },
    sqliteExtended: {
      dbJournalMode: 'wal',
      dbBusyTimeoutMs: 5000,
      dbTransactionLockup: false,
      dbWalCheckpointBusy: false,
      dbWalCheckpointLogPages: 0,
      dbWalCheckpointDonePages: 0,
    },
    performanceExtended: {
      eventLoopLagMs: 0,
      heapUsedBytes: 10 * 1024 * 1024,
      heapTotalBytes: 20 * 1024 * 1024,
      gcThrashingActive: false,
      zstdCompressionCpuSpikeSec: 0,
    },
    upgradeExtended: {
      upgradeLockExists: false,
      upgradeLockStale: false,
      upgradeRestoreStateExists: false,
      upgradeStagedBinaryCorrupt: false,
    },
    windowsExtended: {
      windowsServiceUnquotedPath: false,
      windowsTaskSchedulerXmlCorrupt: false,
    },
    systemdExtended: {
      systemdRuntimeDirMissing: false,
      systemdRateLimitHit: false,
      systemdHomeEncryptedTearing: false,
    },
    configDirPath: '/Users/test/.proxai',
    logDirPath: '/Users/test/.proxai/log',
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

test('A2: null when config absent, registered, or intentionally stopped; finding otherwise', () => {
  expect(checkA2UnitNotRegistered(baseSignals({ configExists: false }))).toBeNull();
  expect(checkA2UnitNotRegistered(baseSignals({ serviceUnitRegistered: true }))).toBeNull();
  expect(
    checkA2UnitNotRegistered(
      baseSignals({
        serviceUnitRegistered: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: true },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA2UnitNotRegistered(baseSignals({ configExists: true, serviceUnitRegistered: false })),
  );
  expect(f.code).toBe('A2');
});

test('A3: stopped-by-user fires on sessionStopped even when the unit is not registered', () => {
  expect(checkA3StoppedByUser(baseSignals({ configExists: false }))).toBeNull();
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
        serviceUnitRegistered: false,
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

test('A5: stays silent while AUTH_FAILED is set (capture paused by design)', () => {
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const signals = baseSignals({
    daemonState: { ...baseSignals().daemonState, captureLastCycleAt: stale },
    sentinels: { ...baseSignals().sentinels, authFailed: true },
  });
  expect(checkA5Wedged(signals)).toBeNull();
});

test('B1: AUTH_FAILED sentinel flags invalid key', () => {
  expect(checkB1InvalidKey(withSentinels({ authFailed: false }))).toBeNull();
  const f = requireDefined(checkB1InvalidKey(withSentinels({ authFailed: true })));
  expect(f.code).toBe('B1');
  expect(f.severity).toBe(Severity.critical);
});

test('B1: surfaces the in-progress trial count while auto-recovery retries', () => {
  const f = requireDefined(
    checkB1InvalidKey(
      withSentinels({ authFailed: true, authFailedRetryAttempts: 4, authFailedRetryMax: 16 }),
    ),
  );
  expect(f.cause).toContain('attempt 4/16');
});

test('B1: reports auto-recovery exhausted after maxRetries', () => {
  const f = requireDefined(
    checkB1InvalidKey(
      withSentinels({ authFailed: true, authFailedRetryExhausted: true, authFailedRetryMax: 16 }),
    ),
  );
  expect(f.cause).toContain('gave up after 16 retries');
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

function withAuthFailedAndError(lastUploadError: string | null): DoctorSignals {
  return baseSignals({
    sentinels: { ...baseSignals().sentinels, authFailed: true },
    daemonState: { ...baseSignals().daemonState, lastUploadError },
  });
}

test('B3: gateway key authentication error based on lastUploadError + AUTH_FAILED sentinel', () => {
  expect(checkB3IngestionKeyAuthError(withAuthFailedAndError(null))).toBeNull();
  expect(checkB3IngestionKeyAuthError(withAuthFailedAndError('some other error'))).toBeNull();

  const f1 = requireDefined(
    checkB3IngestionKeyAuthError(withAuthFailedAndError('HTTP 403 Forbidden')),
  );
  expect(f1.code).toBe('B3');
  expect(f1.severity).toBe(Severity.critical);
  expect(f1.confidence).toBe(Confidence.confirmed);

  const f2 = requireDefined(
    checkB3IngestionKeyAuthError(withAuthFailedAndError('invalid gateway key provided')),
  );
  expect(f2.code).toBe('B3');
  expect(f2.severity).toBe(Severity.critical);
});

test('B3: stays silent on transient 403 host-auth error when AUTH_FAILED sentinel is absent', () => {
  expect(
    checkB3IngestionKeyAuthError(
      withDaemonState({
        lastUploadError: 'server returned 403: host not authorized for this gateway key',
      }),
    ),
  ).toBeNull();
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
          claudeDesktopExists: false,
          geminiExists: false,
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
          claudeDesktopExists: false,
          geminiExists: false,
        },
      }),
    ),
  );
  expect(warn.code).toBe('D1');
  expect(warn.severity).toBe(Severity.warning);
});

test('D1: info (not warning) when only the gemini source dir exists', () => {
  const info = requireDefined(
    checkD1NoAgentActivity(
      baseSignals({
        buffer: { ...baseSignals().buffer, pendingCount: 0, receiptCount: 0 },
        sourcePaths: {
          claudeCodeExists: false,
          cursorExists: false,
          codexExists: false,
          claudeDesktopExists: false,
          geminiExists: true,
        },
      }),
    ),
  );
  expect(info.code).toBe('D1');
  expect(info.severity).toBe(Severity.info);
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

test('D3: null when no source has capture errors', () => {
  expect(checkD3SourceCaptureErrors(baseSignals({ captureErrors: [] }))).toBeNull();
});

test('D3: null when capture errors are below the persistent threshold', () => {
  expect(
    checkD3SourceCaptureErrors(
      baseSignals({
        captureErrors: [{ sourceApp: 'gemini', maxConsecutiveErrors: 2, affectedFiles: 1 }],
      }),
    ),
  ).toBeNull();
});

test('D3: warning naming gemini when it has persistent capture errors', () => {
  const finding = requireDefined(
    checkD3SourceCaptureErrors(
      baseSignals({
        captureErrors: [
          { sourceApp: 'gemini', maxConsecutiveErrors: 5, affectedFiles: 2 },
          { sourceApp: 'cursor', maxConsecutiveErrors: 1, affectedFiles: 1 },
        ],
      }),
    ),
  );
  expect(finding.code).toBe('D3');
  expect(finding.severity).toBe(Severity.warning);
  expect(finding.cause).toContain('gemini');
  expect(finding.cause).toContain('5 consecutive failures across 2 file(s)');
  expect(finding.cause).not.toContain('cursor');
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

test('G1: null when not configured or readable, finding when configured + unreadable', () => {
  expect(
    checkG1ReceiptsTableReadable(
      baseSignals({ configExists: false, receiptsTableReadable: false }),
    ),
  ).toBeNull();
  expect(checkG1ReceiptsTableReadable(baseSignals({ receiptsTableReadable: true }))).toBeNull();
  const f = requireDefined(
    checkG1ReceiptsTableReadable(baseSignals({ receiptsTableReadable: false })),
  );
  expect(f.code).toBe('G1');
  expect(f.severity).toBe(Severity.critical);
});

test('G2: null when not configured or readable, finding when configured + unreadable', () => {
  expect(
    checkG2BufferDbCorrupt(baseSignals({ configExists: false, bufferDbReadable: false })),
  ).toBeNull();
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

test('A6: abrupt daemon termination', () => {
  expect(checkA6AbruptDaemonTermination(baseSignals({ daemonRunning: true }))).toBeNull();
  expect(
    checkA6AbruptDaemonTermination(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: true },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA6AbruptDaemonTermination(
      baseSignals({
        daemonRunning: false,
        sentinels: { ...baseSignals().sentinels, sessionStopped: false },
        daemonState: { ...baseSignals().daemonState, captureLastCycleAt: '2026-05-28' },
      }),
    ),
  );
  expect(f.code).toBe('A6');
});

test('A7: zombie daemon', () => {
  expect(
    checkA7ZombieDaemon(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, zombieProcessesDetected: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA7ZombieDaemon(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, zombieProcessesDetected: true },
      }),
    ),
  );
  expect(f.code).toBe('A7');
});

test('A8: graceful termination lockup', () => {
  expect(checkA8GracefulTerminationLockup(baseSignals({ daemonRunning: false }))).toBeNull();
  expect(
    checkA8GracefulTerminationLockup(
      baseSignals({
        daemonRunning: true,
        processExtended: { ...baseSignals().processExtended, controlSocketExists: false },
      }),
    ),
  ).toBeNull();
  expect(
    checkA8GracefulTerminationLockup(
      baseSignals({
        daemonRunning: true,
        processExtended: {
          ...baseSignals().processExtended,
          controlSocketExists: true,
          controlSocketActive: true,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA8GracefulTerminationLockup(
      baseSignals({
        daemonRunning: true,
        processExtended: {
          ...baseSignals().processExtended,
          controlSocketExists: true,
          controlSocketActive: false,
        },
      }),
    ),
  );
  expect(f.code).toBe('A8');
});

test('A9: helper process healthy', () => {
  expect(
    checkA9HelperProcessHealthy(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, helperProcessHealthy: true },
      }),
    ),
  ).toBeNull();
  expect(
    checkA9HelperProcessHealthy(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, helperProcessHealthy: null },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA9HelperProcessHealthy(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, helperProcessHealthy: false },
      }),
    ),
  );
  expect(f.code).toBe('A9');
});

test('A10: thread watcher exhaustion', () => {
  expect(
    checkA10ThreadWatcherExhaustion(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, watcherThreadLagMs: 100 },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA10ThreadWatcherExhaustion(
      baseSignals({
        processExtended: { ...baseSignals().processExtended, watcherThreadLagMs: 600 },
      }),
    ),
  );
  expect(f.code).toBe('A10');
});

test('A11: windows service unquoted path', () => {
  expect(
    checkA11WindowsServiceUnquotedPath(
      baseSignals({
        windowsExtended: { ...baseSignals().windowsExtended, windowsServiceUnquotedPath: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA11WindowsServiceUnquotedPath(
      baseSignals({
        windowsExtended: { ...baseSignals().windowsExtended, windowsServiceUnquotedPath: true },
      }),
    ),
  );
  expect(f.code).toBe('A11');
});

test('A12: windows task scheduler xml corrupt', () => {
  expect(
    checkA12WindowsTaskSchedulerXmlCorrupt(
      baseSignals({
        windowsExtended: {
          ...baseSignals().windowsExtended,
          windowsTaskSchedulerXmlCorrupt: false,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA12WindowsTaskSchedulerXmlCorrupt(
      baseSignals({
        windowsExtended: { ...baseSignals().windowsExtended, windowsTaskSchedulerXmlCorrupt: true },
      }),
    ),
  );
  expect(f.code).toBe('A12');
});

test('A13: systemd runtime dir missing', () => {
  expect(
    checkA13SystemdRuntimeDirMissing(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdRuntimeDirMissing: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA13SystemdRuntimeDirMissing(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdRuntimeDirMissing: true },
      }),
    ),
  );
  expect(f.code).toBe('A13');
});

test('A14: systemd rate limit hit', () => {
  expect(
    checkA14SystemdRateLimitHit(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdRateLimitHit: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA14SystemdRateLimitHit(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdRateLimitHit: true },
      }),
    ),
  );
  expect(f.code).toBe('A14');
});

test('A15: systemd home encrypted tearing', () => {
  expect(
    checkA15SystemdHomeEncryptedTearing(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdHomeEncryptedTearing: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkA15SystemdHomeEncryptedTearing(
      baseSignals({
        systemdExtended: { ...baseSignals().systemdExtended, systemdHomeEncryptedTearing: true },
      }),
    ),
  );
  expect(f.code).toBe('A15');
});

test('B4: insecure api key transmission', () => {
  expect(
    checkB4InsecureApiKeyTransmission(
      baseSignals({
        securityExtended: { ...baseSignals().securityExtended, configUnescapedBackslashes: false },
        networkExtended: { ...baseSignals().networkExtended, tlsInspectionDetected: false },
      }),
    ),
  ).toBeNull();
  expect(
    checkB4InsecureApiKeyTransmission(
      baseSignals({
        securityExtended: { ...baseSignals().securityExtended, configUnescapedBackslashes: true },
        networkExtended: { ...baseSignals().networkExtended, tlsInspectionDetected: false },
      }),
    ),
  ).toBeNull();
  const originalVal = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  try {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const f = requireDefined(
      checkB4InsecureApiKeyTransmission(
        baseSignals({
          securityExtended: { ...baseSignals().securityExtended, configUnescapedBackslashes: true },
        }),
      ),
    );
    expect(f.code).toBe('B4');
  } finally {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalVal;
  }
});

test('B5: permissive config permissions', () => {
  expect(checkB5PermissiveConfigPermissions(baseSignals({ configExists: false }))).toBeNull();
  expect(
    checkB5PermissiveConfigPermissions(
      baseSignals({
        configExists: true,
        securityExtended: {
          ...baseSignals().securityExtended,
          configValueConstraintsViolated: false,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkB5PermissiveConfigPermissions(
      baseSignals({
        configExists: true,
        securityExtended: {
          ...baseSignals().securityExtended,
          configValueConstraintsViolated: true,
        },
      }),
    ),
  );
  expect(f.code).toBe('B5');
});

test('B6: overly broad directory watches', () => {
  expect(
    checkB6OverlyBroadDirectoryWatches(
      baseSignals({
        securityExtended: { ...baseSignals().securityExtended, configObsoleteKeys: [] },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkB6OverlyBroadDirectoryWatches(
      baseSignals({
        securityExtended: { ...baseSignals().securityExtended, configObsoleteKeys: ['broad_key'] },
      }),
    ),
  );
  expect(f.code).toBe('B6');
});

test('C8: outbound tls inspection', () => {
  expect(
    checkC8OutboundTlsInspection(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, tlsInspectionDetected: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC8OutboundTlsInspection(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, tlsInspectionDetected: true },
      }),
    ),
  );
  expect(f.code).toBe('C8');
});

test('C9: global proxy mismatch', () => {
  expect(
    checkC9GlobalProxyMismatch(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, globalProxyMismatch: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC9GlobalProxyMismatch(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, globalProxyMismatch: true },
      }),
    ),
  );
  expect(f.code).toBe('C9');
});

test('C10: dns hijack captive portal', () => {
  expect(
    checkC10DnsHijackCaptivePortal(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, dnsHijackOrCaptivePortal: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC10DnsHijackCaptivePortal(
      baseSignals({
        networkExtended: { ...baseSignals().networkExtended, dnsHijackOrCaptivePortal: true },
      }),
    ),
  );
  expect(f.code).toBe('C10');
});

test('C11: throttler reset skew', () => {
  expect(checkC11ThrottlerResetSkew(baseSignals({ clockSkewMs: null }))).toBeNull();
  expect(checkC11ThrottlerResetSkew(baseSignals({ clockSkewMs: 1000 }))).toBeNull();
  const f = requireDefined(checkC11ThrottlerResetSkew(baseSignals({ clockSkewMs: 40000 })));
  expect(f.code).toBe('C11');
});

test('C12: thundering herd jitter', () => {
  expect(
    checkC12ThunderingHerdJitter(
      baseSignals({ resyncEvents: { ...baseSignals().resyncEvents, regressionLoops: [] } }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC12ThunderingHerdJitter(
      baseSignals({
        resyncEvents: {
          ...baseSignals().resyncEvents,
          regressionLoops: [{ sourcePathHash: 'h', countInLastHour: 6 }],
        },
      }),
    ),
  );
  expect(f.code).toBe('C12');
});

test('C13: outbox timeout', () => {
  expect(
    checkC13OutboxTimeout(
      baseSignals({ recentEvents: { ...baseSignals().recentEvents, retriableCount: 2 } }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkC13OutboxTimeout(
      baseSignals({ recentEvents: { ...baseSignals().recentEvents, retriableCount: 15 } }),
    ),
  );
  expect(f.code).toBe('C13');
});

test('E5: upgrade lock stale', () => {
  expect(
    checkE5UpgradeLockStale(
      baseSignals({
        upgradeExtended: { ...baseSignals().upgradeExtended, upgradeLockExists: false },
      }),
    ),
  ).toBeNull();
  expect(
    checkE5UpgradeLockStale(
      baseSignals({
        upgradeExtended: {
          ...baseSignals().upgradeExtended,
          upgradeLockExists: true,
          upgradeLockStale: false,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkE5UpgradeLockStale(
      baseSignals({
        upgradeExtended: {
          ...baseSignals().upgradeExtended,
          upgradeLockExists: true,
          upgradeLockStale: true,
        },
      }),
    ),
  );
  expect(f.code).toBe('E5');
});

test('E6: corrupted upgrade binary', () => {
  expect(
    checkE6CorruptedUpgradeBinary(
      baseSignals({
        upgradeExtended: { ...baseSignals().upgradeExtended, upgradeStagedBinaryCorrupt: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkE6CorruptedUpgradeBinary(
      baseSignals({
        upgradeExtended: { ...baseSignals().upgradeExtended, upgradeStagedBinaryCorrupt: true },
      }),
    ),
  );
  expect(f.code).toBe('E6');
});

test('E7: homebrew relocation drift', () => {
  expect(checkE7HomebrewRelocationDrift(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkE7HomebrewRelocationDrift(baseSignals({ platform: 'darwin', macOsQuarantineXattr: null })),
  ).toBeNull();
  const originalArch = process.arch;

  try {
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    expect(
      checkE7HomebrewRelocationDrift(
        baseSignals({ platform: 'darwin', macOsQuarantineXattr: false }),
      ),
    ).toBeNull();
  } finally {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  }

  try {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    expect(
      checkE7HomebrewRelocationDrift(
        baseSignals({
          platform: 'darwin',
          macOsQuarantineXattr: false,
          filesystem: { ...baseSignals().filesystem, configDirWritable: false },
        }),
      ),
    ).toBeNull();
  } finally {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  }

  try {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    const f = requireDefined(
      checkE7HomebrewRelocationDrift(
        baseSignals({
          platform: 'darwin',
          macOsQuarantineXattr: false,
          filesystem: { ...baseSignals().filesystem, configDirWritable: true },
        }),
      ),
    );
    expect(f.code).toBe('E7');
  } finally {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  }
});

test('F8: macOS TCC FDA check', () => {
  expect(checkF8MacOsTccFDA(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkF8MacOsTccFDA(
      baseSignals({
        platform: 'darwin',
        filesystem: { ...baseSignals().filesystem, configDirWritable: true },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF8MacOsTccFDA(
      baseSignals({
        platform: 'darwin',
        filesystem: { ...baseSignals().filesystem, configDirWritable: false },
      }),
    ),
  );
  expect(f.code).toBe('F8');
});

test('F9: macOS Gatekeeper translocation', () => {
  expect(checkF9MacOsGatekeeperTranslocation(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkF9MacOsGatekeeperTranslocation(
      baseSignals({ platform: 'darwin', macOsQuarantineXattr: false }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF9MacOsGatekeeperTranslocation(
      baseSignals({ platform: 'darwin', macOsQuarantineXattr: true }),
    ),
  );
  expect(f.code).toBe('F9');
});

test('F10: macOS sandboxed terminal locks', () => {
  expect(checkF10SandboxedTerminalLocks(baseSignals({ platform: 'linux' }))).toBeNull();
  expect(
    checkF10SandboxedTerminalLocks(
      baseSignals({
        platform: 'darwin',
        filesystem: { ...baseSignals().filesystem, configDirWritable: true },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF10SandboxedTerminalLocks(
      baseSignals({
        platform: 'darwin',
        filesystem: { ...baseSignals().filesystem, configDirWritable: false },
      }),
    ),
  );
  expect(f.code).toBe('F10');
});

test('F11: symlink traversal loop', () => {
  expect(
    checkF11SymlinkTraversalLoop(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, symlinkLoopDetected: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF11SymlinkTraversalLoop(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, symlinkLoopDetected: true },
      }),
    ),
  );
  expect(f.code).toBe('F11');
});

test('F12: POSIX extended ACL blocked', () => {
  expect(
    checkF12POSIXExtendedAclBlocked(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, aclWriteBlocked: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF12POSIXExtendedAclBlocked(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, aclWriteBlocked: true },
      }),
    ),
  );
  expect(f.code).toBe('F12');
});

test('F13: broken windows junction', () => {
  expect(
    checkF13BrokenWindowsJunction(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, brokenWindowsJunctions: [] },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF13BrokenWindowsJunction(
      baseSignals({
        filesystemExtended: {
          ...baseSignals().filesystemExtended,
          brokenWindowsJunctions: ['junc'],
        },
      }),
    ),
  );
  expect(f.code).toBe('F13');
});

test('F14: log rotation inode drift', () => {
  expect(
    checkF14LogRotationInodeDrift(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, logInodeDriftDetected: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF14LogRotationInodeDrift(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, logInodeDriftDetected: true },
      }),
    ),
  );
  expect(f.code).toBe('F14');
});

test('F15: physical write exhaustion', () => {
  expect(
    checkF15PhysicalWriteExhaustion(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, writeProbeSuccess: true },
      }),
    ),
  ).toBeNull();
  expect(
    checkF15PhysicalWriteExhaustion(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, writeProbeSuccess: false },
        filesystem: { ...baseSignals().filesystem, configDirWritable: false },
      }),
    ),
  ).toBeNull();
  const f1 = requireDefined(
    checkF15PhysicalWriteExhaustion(
      baseSignals({
        filesystemExtended: {
          ...baseSignals().filesystemExtended,
          writeProbeSuccess: false,
          writeProbeError: 'EROFS',
        },
        filesystem: { ...baseSignals().filesystem, configDirWritable: true },
      }),
    ),
  );
  expect(f1.code).toBe('F15');

  const f2 = requireDefined(
    checkF15PhysicalWriteExhaustion(
      baseSignals({
        filesystemExtended: {
          ...baseSignals().filesystemExtended,
          writeProbeSuccess: false,
          writeProbeError: 'ENOSPC',
        },
        filesystem: { ...baseSignals().filesystem, configDirWritable: true },
      }),
    ),
  );
  expect(f2.code).toBe('F15');
  expect(f2.cause).toContain('inodes');

  const f3 = requireDefined(
    checkF15PhysicalWriteExhaustion(
      baseSignals({
        filesystemExtended: {
          ...baseSignals().filesystemExtended,
          writeProbeSuccess: false,
          writeProbeError: 'EIO',
        },
        filesystem: { ...baseSignals().filesystem, configDirWritable: true },
      }),
    ),
  );
  expect(f3.code).toBe('F15');
  expect(f3.cause).toContain('I/O exhaustion');
});

test('F16: sudo hijack ownership drift', () => {
  expect(
    checkF16SudoHijackOwnershipDrift(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, sudoOwnershipDrift: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF16SudoHijackOwnershipDrift(
      baseSignals({
        filesystemExtended: { ...baseSignals().filesystemExtended, sudoOwnershipDrift: true },
      }),
    ),
  );
  expect(f.code).toBe('F16');
});

test('F17: event loop lag', () => {
  expect(
    checkF17V8SyncEventLoopLag(
      baseSignals({
        performanceExtended: { ...baseSignals().performanceExtended, eventLoopLagMs: 50 },
      }),
    ),
  ).toBeNull();
  expect(
    checkF17V8SyncEventLoopLag(
      baseSignals({
        performanceExtended: { ...baseSignals().performanceExtended, eventLoopLagMs: null },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF17V8SyncEventLoopLag(
      baseSignals({
        performanceExtended: { ...baseSignals().performanceExtended, eventLoopLagMs: 120 },
      }),
    ),
  );
  expect(f.code).toBe('F17');
});

test('F18: fires on GC thrashing, not on the heap ratio (invalid on Bun/JSC)', () => {
  expect(
    checkF18V8HeapExhaustion(
      baseSignals({
        performanceExtended: {
          ...baseSignals().performanceExtended,
          heapUsedBytes: 9,
          heapTotalBytes: 10,
          gcThrashingActive: false,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkF18V8HeapExhaustion(
      baseSignals({
        performanceExtended: { ...baseSignals().performanceExtended, gcThrashingActive: true },
      }),
    ),
  );
  expect(f.code).toBe('F18');
});

test('G4: journal mode', () => {
  expect(checkG4JournalMode(baseSignals({ bufferDbReadable: false }))).toBeNull();
  expect(
    checkG4JournalMode(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbJournalMode: 'wal' },
      }),
    ),
  ).toBeNull();
  expect(
    checkG4JournalMode(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbJournalMode: 'WAL' },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG4JournalMode(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbJournalMode: 'delete' },
      }),
    ),
  );
  expect(f.code).toBe('G4');
});

test('G5: busy timeout', () => {
  expect(checkG5BusyTimeout(baseSignals({ bufferDbReadable: false }))).toBeNull();
  expect(
    checkG5BusyTimeout(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbBusyTimeoutMs: 3000 },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG5BusyTimeout(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbBusyTimeoutMs: 500 },
      }),
    ),
  );
  expect(f.code).toBe('G5');
});

test('G6: transaction lockup', () => {
  expect(checkG6TransactionLockup(baseSignals({ bufferDbReadable: false }))).toBeNull();
  expect(
    checkG6TransactionLockup(baseSignals({ bufferDbReadable: true, daemonRunning: false })),
  ).toBeNull();
  expect(
    checkG6TransactionLockup(
      baseSignals({
        bufferDbReadable: true,
        daemonRunning: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbTransactionLockup: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG6TransactionLockup(
      baseSignals({
        bufferDbReadable: true,
        daemonRunning: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbTransactionLockup: true },
      }),
    ),
  );
  expect(f.code).toBe('G6');
});

test('G7: WAL checkpoint starvation', () => {
  expect(checkG7WalCheckpointStarvation(baseSignals({ bufferDbReadable: false }))).toBeNull();
  expect(
    checkG7WalCheckpointStarvation(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbWalCheckpointBusy: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG7WalCheckpointStarvation(
      baseSignals({
        bufferDbReadable: true,
        sqliteExtended: { ...baseSignals().sqliteExtended, dbWalCheckpointBusy: true },
      }),
    ),
  );
  expect(f.code).toBe('G7');
});

test('G8: uncommitted journal stale lock', () => {
  expect(checkG8UncommittedJournalStaleLock(baseSignals({ daemonRunning: true }))).toBeNull();
  expect(
    checkG8UncommittedJournalStaleLock(
      baseSignals({
        daemonRunning: false,
        processExtended: { ...baseSignals().processExtended, zombieProcessesDetected: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG8UncommittedJournalStaleLock(
      baseSignals({
        daemonRunning: false,
        processExtended: { ...baseSignals().processExtended, zombieProcessesDetected: true },
      }),
    ),
  );
  expect(f.code).toBe('G8');
});

test('G9: inconsistent session UUIDs', () => {
  expect(
    checkG9InconsistentSessionUuids(
      baseSignals({
        sqliteExtended: { ...baseSignals().sqliteExtended, dbTransactionLockup: false },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG9InconsistentSessionUuids(
      baseSignals({
        sqliteExtended: { ...baseSignals().sqliteExtended, dbTransactionLockup: true },
      }),
    ),
  );
  expect(f.code).toBe('G9');
});

test('G10: compression spikes', () => {
  expect(
    checkG10CompressionSpikes(
      baseSignals({
        performanceExtended: {
          ...baseSignals().performanceExtended,
          zstdCompressionCpuSpikeSec: 0.5,
        },
      }),
    ),
  ).toBeNull();
  expect(
    checkG10CompressionSpikes(
      baseSignals({
        performanceExtended: {
          ...baseSignals().performanceExtended,
          zstdCompressionCpuSpikeSec: null,
        },
      }),
    ),
  ).toBeNull();
  const f = requireDefined(
    checkG10CompressionSpikes(
      baseSignals({
        performanceExtended: {
          ...baseSignals().performanceExtended,
          zstdCompressionCpuSpikeSec: 2.0,
        },
      }),
    ),
  );
  expect(f.code).toBe('G10');
});
