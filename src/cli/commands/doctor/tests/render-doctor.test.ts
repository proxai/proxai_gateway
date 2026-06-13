import { expect, test } from 'bun:test';
import chalk from 'chalk';

import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';
import { renderDoctorOutput, generateDoctorHtml } from 'cli/commands/doctor/render-doctor.ts';
import { formatLocalTimestamp } from 'core/utils/format.ts';

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

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
      receiptCount: 0,
      lastPruneAt: null,
      lastSuccessAt: null,
    },
    daemonState: {
      captureLastCycleAt: null,
      drainLastCycleAt: null,
      lastConsecutiveRetriableBreak: null,
      lastUploadError: null,
    },
    binary: {
      version: '2026.5.28',
      mtime: null,
      installSource: null,
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
      nestReachable: null,
    },
    sourcePaths: {
      claudeCodeExists: false,
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
    systemdLingerEnabled: null,
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

function makeFinding(over: Partial<Finding> & Pick<Finding, 'code' | 'severity'>): Finding {
  return {
    confidence: Confidence.confirmed,
    cause: 'cause text',
    action: 'action text',
    ...over,
  };
}

test('renders no-issues healthy block', () => {
  const out = stripAnsi(renderDoctorOutput([], baseSignals()));
  expect(out).toContain('=== proxai-gateway doctor ===');
  expect(out).toContain('No issues found.');
  expect(out).not.toContain('Healthy checks');
});

test('renders critical, warning, and info sections sorted by severity', () => {
  const findings: Finding[] = [
    makeFinding({ code: 'C7', severity: Severity.info }),
    makeFinding({ code: 'B1', severity: Severity.critical }),
    makeFinding({ code: 'F3', severity: Severity.warning }),
  ];
  const out = stripAnsi(renderDoctorOutput(findings, baseSignals()));
  expect(out).toContain('CRITICAL (1)');
  expect(out).toContain('WARNING (1)');
  expect(out).toContain('INFO (1)');
  const criticalIdx = out.indexOf('CRITICAL');
  const warningIdx = out.indexOf('WARNING');
  const infoIdx = out.indexOf('INFO');
  expect(criticalIdx).toBeLessThan(warningIdx);
  expect(warningIdx).toBeLessThan(infoIdx);
  expect(out).toContain('B1 cause text');
  expect(out).toContain('-> action text');
});

test('renders only-critical findings (no warning/info sections)', () => {
  const findings: Finding[] = [makeFinding({ code: 'B1', severity: Severity.critical })];
  const out = stripAnsi(renderDoctorOutput(findings, baseSignals()));
  expect(out).toContain('CRITICAL (1)');
  expect(out).not.toContain('WARNING (');
  expect(out).not.toContain('INFO (');
});

test('signals appendix renders null placeholders for absent optional values', () => {
  const out = stripAnsi(renderDoctorOutput([], baseSignals()));
  expect(out).toContain('SIGNALS');
  expect(out).toContain('last_prune_at:           null');
  expect(out).toContain('capture_last_cycle_at:   null');
  expect(out).toContain('retriable_break:         null');
  expect(out).toContain('mtime:                   null');
  expect(out).toContain('install_source:          null');
  expect(out).toContain('disk_free_bytes:         null');
  expect(out).toContain('nest_reachable:          null');
  expect(out).toContain('regression_loops:        none');
  expect(out).toContain('systemd_linger:          null');
  expect(out).toContain('macos_quarantine:        null');
  expect(out).toContain('clock_skew_ms:           null');
});

test('signals appendix renders populated optional values and regression loops', () => {
  const signals = baseSignals({
    buffer: {
      pendingCount: 1,
      pendingBytes: 200,
      failedCount: 0,
      quarantinedCount: 0,
      receiptCount: 3,
      lastPruneAt: '2026-05-28T00:00:00.000Z',
      lastSuccessAt: '2026-05-28T01:00:00.000Z',
    },
    daemonState: {
      captureLastCycleAt: '2026-05-28T00:00:00.000Z',
      drainLastCycleAt: '2026-05-28T00:00:30.000Z',
      lastConsecutiveRetriableBreak: true,
      lastUploadError: null,
    },
    binary: {
      version: '2026.5.28',
      mtime: new Date('2026-05-28T00:00:00.000Z'),
      installSource: 'npm',
    },
    recentEvents: {
      authUnconfirmedCount: 0,
      rateLimitedCount: 0,
      retriableCount: 0,
      fatalValidationErrorCount: 0,
      autoUpgradeEvents: ['success'],
    },
    filesystem: {
      configDirWritable: true,
      logDirWritable: true,
      diskFreeBytes: 12345,
    },
    network: { nestReachable: true },
    resyncEvents: {
      totalCount: 7,
      regressionLoops: [{ sourcePathHash: 'abc123', countInLastHour: 9 }],
    },
    captureErrors: [{ sourceApp: 'gemini', maxConsecutiveErrors: 4, affectedFiles: 2 }],
    platform: 'linux',
    systemdLingerEnabled: false,
    macOsQuarantineXattr: true,
    clockSkewMs: 4000,
  });
  const out = stripAnsi(renderDoctorOutput([], signals));
  expect(out).toContain('capture_errors:');
  expect(out).toContain('gemini: 4 consecutive on 2 file(s)');
  expect(out).toContain(
    `last_prune_at:           ${formatLocalTimestamp('2026-05-28T00:00:00.000Z')}`,
  );
  expect(out).toContain('retriable_break:         true');
  expect(out).toContain(
    `mtime:                   ${formatLocalTimestamp('2026-05-28T00:00:00.000Z')}`,
  );
  expect(out).toContain('install_source:          npm');
  expect(out).toContain('disk_free_bytes:         12345');
  expect(out).toContain('nest_reachable:          true');
  expect(out).toContain('auto_upgrade_events:     [success]');
  expect(out).toContain('regression_loops:');
  expect(out).toContain('abc123: 9 in last hour');
  expect(out).toContain('systemd_linger:          false');
  expect(out).toContain('macos_quarantine:        true');
  expect(out).toContain('clock_skew_ms:           4000');
});

test('renderDoctorOutput always shows the signals appendix and a single summary', () => {
  const out = stripAnsi(renderDoctorOutput([], baseSignals()));
  expect(out).toContain('SIGNALS');
  expect(out).toContain('last_prune_at:');
  const summaryCount = out.split('DIAGNOSTICS SUMMARY').length - 1;
  expect(summaryCount).toBe(1);
});

test('respects process.stdout.columns and shrinks divider width accordingly', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 40,
      configurable: true,
    });

    const out = stripAnsi(renderDoctorOutput([], baseSignals()));
    expect(out).toContain('═'.repeat(40));
    expect(out).not.toContain('═'.repeat(60));
    expect(out).toContain('          DIAGNOSTICS SUMMARY');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('centerText falls back to direct output when text is wider than container width', () => {
  const originalColumns = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', {
      value: 4,
      configurable: true,
    });
    const out = stripAnsi(renderDoctorOutput([], baseSignals()));
    expect(out).toContain('SIGNALS');
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  }
});

test('signals appendix renders last upload error when present', () => {
  const signals = baseSignals({
    daemonState: {
      captureLastCycleAt: null,
      drainLastCycleAt: null,
      lastConsecutiveRetriableBreak: null,
      lastUploadError: 'failed to establish secure connection',
    },
  });
  const out = stripAnsi(renderDoctorOutput([], signals));
  expect(out).toContain('last_upload_error:       failed to establish secure connection');
});

test('generateDoctorHtml renders HTML report correctly for healthy system', () => {
  const html = generateDoctorHtml([], baseSignals(), '2026-05-28T12:00:00Z');
  expect(html).toContain('<!DOCTYPE html>');
  expect(html).toContain('System is completely healthy. No issues found!');
  expect(html).toContain('2026-05-28T12:00:00Z');
  expect(html).toContain('All systems healthy');
  expect(html).toContain('<div class="wordmark">ProxAI</div>');
});

test('generateDoctorHtml is fully self-contained with no external resources', () => {
  const html = generateDoctorHtml([], baseSignals(), '2026-05-28T12:00:00Z');
  expect(html).not.toContain('cdn.tailwindcss.com');
  expect(html).not.toContain('fonts.googleapis.com');
  expect(html).not.toContain('Antigravity');
  expect(html).not.toContain('http://');
  expect(html).not.toContain('https://');
  expect(html).not.toContain('<script');
  expect(html).toContain('data:image/svg+xml;base64,');
});

test('generateDoctorHtml renders populated signals and a single-severity summary', () => {
  const signals = baseSignals({
    buffer: {
      pendingCount: 1,
      pendingBytes: 200,
      failedCount: 2,
      quarantinedCount: 0,
      receiptCount: 3,
      lastPruneAt: '2026-05-28T00:00:00.000Z',
      lastSuccessAt: '2026-05-28T01:00:00.000Z',
    },
    daemonState: {
      captureLastCycleAt: '2026-05-28T00:00:00.000Z',
      drainLastCycleAt: '2026-05-28T00:00:30.000Z',
      lastConsecutiveRetriableBreak: true,
      lastUploadError: 'connection reset',
    },
    binary: {
      version: '2026.5.28',
      mtime: new Date('2026-05-28T00:00:00.000Z'),
      installSource: 'npm',
    },
    recentEvents: {
      authUnconfirmedCount: 0,
      rateLimitedCount: 0,
      retriableCount: 0,
      fatalValidationErrorCount: 0,
      autoUpgradeEvents: ['success'],
    },
    filesystem: { configDirWritable: true, logDirWritable: true, diskFreeBytes: 12345 },
    network: { nestReachable: true },
    resyncEvents: {
      totalCount: 7,
      regressionLoops: [{ sourcePathHash: 'abc123', countInLastHour: 9 }],
    },
    captureErrors: [{ sourceApp: 'gemini', maxConsecutiveErrors: 4, affectedFiles: 2 }],
    systemdLingerEnabled: false,
    macOsQuarantineXattr: true,
    clockSkewMs: 4000,
  });
  const findings: Finding[] = [makeFinding({ code: 'B1', severity: Severity.critical })];

  const html = generateDoctorHtml(findings, signals, '2026-05-28T12:00:00Z');
  expect(html).toContain('consecutive on');
  expect(html).toContain('Critical Issues (1)');
  expect(html).not.toContain('Warnings (');
  expect(html).not.toContain('Info (');
  expect(html).toContain('1 issue found');
  expect(html).toContain('abc123');
  expect(html).toContain('success');
  expect(html).toContain('connection reset');
  expect(html).toContain('npm');
  expect(html).toContain('12345');
  expect(html).toContain(formatLocalTimestamp('2026-05-28T00:00:00.000Z'));
});

test('signals appendix colors booleans by health polarity, not by literal value', () => {
  const prevLevel = chalk.level;
  chalk.level = 1;
  try {
    const signals = baseSignals({
      daemonRunning: false,
      sentinels: {
        authFailed: true,
        authFailedRetryAttempts: 0,
        authFailedRetryMax: 0,
        authFailedRetryExhausted: false,
        bufferFull: false,
        sessionStopped: false,
        updateAvailable: false,
      },
    });
    const out = renderDoctorOutput([], signals);
    expect(out).toContain(`AUTH_FAILED:             ${chalk.red('true')}`);
    expect(out).toContain(`BUFFER_FULL:             ${chalk.green('false')}`);
    expect(out).toContain(`daemon_running:            ${chalk.red('false')}`);
    expect(out).toContain(`cursor_exists:           ${chalk.cyan('false')}`);
  } finally {
    chalk.level = prevLevel;
  }
});

test('generateDoctorHtml colors booleans by health polarity, not by literal value', () => {
  const signals = baseSignals({
    daemonRunning: false,
    macOsQuarantineXattr: true,
    sentinels: {
      authFailed: true,
      authFailedRetryAttempts: 0,
      authFailedRetryMax: 0,
      authFailedRetryExhausted: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: true,
    },
  });
  const html = generateDoctorHtml([], signals, '2026-05-28T12:00:00Z');
  expect(html).toContain('<span class="v-bad">true</span>');
  expect(html).toContain('<span class="v-good">false</span>');
  expect(html).toContain('<span class="v-bad">false</span>');
  expect(html).toContain('<span class="v-info">false</span>');
  expect(html).toContain('<span class="v-info">true</span>');
  expect(html).not.toContain('v-true');
  expect(html).not.toContain('v-false');
});

test('generateDoctorHtml renders HTML report correctly for multiple issues and escapes HTML characters', () => {
  const findings: Finding[] = [
    makeFinding({
      code: 'B1',
      severity: Severity.critical,
      cause: 'API key containing special characters: <>&"\'',
      action: 'Check ProxAI portal: <>&"\'',
    }),
    makeFinding({
      code: 'F3',
      severity: Severity.warning,
      cause: 'Warning issue',
      action: 'Check warning action',
    }),
    makeFinding({
      code: 'C7',
      severity: Severity.info,
      cause: 'Info issue',
      action: 'Check info action',
    }),
  ];

  const html = generateDoctorHtml(findings, baseSignals(), '2026-05-28T12:00:00Z');
  expect(html).toContain('Critical Issues (1)');
  expect(html).toContain('Warnings (1)');
  expect(html).toContain('Info (1)');
  expect(html).toContain('API key containing special characters: &lt;&gt;&amp;&quot;&#039;');
  expect(html).toContain('Check ProxAI portal: &lt;&gt;&amp;&quot;&#039;');
});
