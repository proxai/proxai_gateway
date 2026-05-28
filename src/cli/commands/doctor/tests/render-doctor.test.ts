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

test('renders no-issues healthy block listing all healthy checks', () => {
  const out = stripAnsi(renderDoctorOutput([], baseSignals()));
  expect(out).toContain('=== proxai-gateway doctor ===');
  expect(out).toContain('No issues found.');
  expect(out).toContain('Healthy checks:');
  expect(out).toContain('[OK] A1 Config present');
  expect(out).toContain('[OK] F2 Disk space adequate');
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
  expect(out).toContain('[CONFIRMED] B1 cause text');
  expect(out).toContain('→ action text');
});

test('lists passing checks excluding ones that produced findings', () => {
  const findings: Finding[] = [makeFinding({ code: 'A1', severity: Severity.critical })];
  const out = stripAnsi(renderDoctorOutput(findings, baseSignals()));
  expect(out).toContain('Passing checks:');
  expect(out).not.toContain('[OK] A1 Config present');
  expect(out).toContain('[OK] A2 Service unit registered');
});

test('always lists the A3/A4 healthy check since no single finding code matches it', () => {
  const codes: Finding['code'][] = ['A1', 'A2', 'A3', 'B1', 'B2', 'C2', 'F1', 'F2'];
  const findings: Finding[] = codes.map((code) =>
    makeFinding({ code, severity: Severity.warning }),
  );
  const out = stripAnsi(renderDoctorOutput(findings, baseSignals()));
  expect(out).toContain('Passing checks:');
  expect(out).toContain('[OK] A3/A4 Daemon running');
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
  expect(out).toContain('--- Signals ---');
  expect(out).toContain('last_prune_at:           null');
  expect(out).toContain('capture_last_cycle_at:   null');
  expect(out).toContain('retriable_break:         null');
  expect(out).toContain('mtime:                   null');
  expect(out).toContain('install_source:          null');
  expect(out).toContain('disk_free_bytes:         null');
  expect(out).toContain('nest_reachable:          null');
  expect(out).not.toContain('regression_loops:');
  expect(out).not.toContain('systemd_linger:');
  expect(out).not.toContain('macos_quarantine:');
  expect(out).not.toContain('clock_skew_ms:');
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
