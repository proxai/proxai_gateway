import { expect, test } from 'bun:test';

import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';
import { renderDoctorOutput } from 'cli/commands/doctor/render-doctor.ts';

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
      geminiCliExists: false,
    },
    resyncEvents: {
      totalCount: 0,
      regressionLoops: [],
    },
    platform: 'linux',
    systemdLingerEnabled: null,
    macOsQuarantineXattr: null,
    clockSkewMs: null,
    bufferDbReadable: true,
    receiptsTableReadable: true,
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
    platform: 'linux',
    systemdLingerEnabled: false,
    macOsQuarantineXattr: true,
    clockSkewMs: 4000,
  });
  const out = stripAnsi(renderDoctorOutput([], signals));
  expect(out).toContain('last_prune_at:           2026-05-28T00:00:00.000Z');
  expect(out).toContain('retriable_break:         true');
  expect(out).toContain('mtime:                   2026-05-28T00:00:00.000Z');
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

test('renderDoctorOutput compact option hides verbose signals appendix completely', () => {
  const out = stripAnsi(renderDoctorOutput([], baseSignals(), true));
  expect(out).not.toContain('SIGNALS');
  expect(out).not.toContain('last_prune_at:');

  const firstIndex = out.indexOf('DIAGNOSTICS SUMMARY');
  const lastIndex = out.lastIndexOf('DIAGNOSTICS SUMMARY');
  expect(firstIndex).toBeGreaterThanOrEqual(0);
  expect(lastIndex).toBeGreaterThan(firstIndex);
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
