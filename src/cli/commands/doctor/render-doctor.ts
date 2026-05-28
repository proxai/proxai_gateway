import { Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.critical]: 0,
  [Severity.warning]: 1,
  [Severity.info]: 2,
  [Severity.healthy]: 3,
};

function sortFindings(findings: readonly Finding[]): Finding[] {
  return findings.toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function renderFinding(finding: Finding): string {
  return `[${finding.confidence}] ${finding.code} ${finding.cause}\n  → ${finding.action}`;
}

function renderSignalsAppendix(signals: DoctorSignals): string {
  const lines: string[] = [];
  lines.push('--- Signals ---');
  lines.push(`platform:                  ${signals.platform}`);
  lines.push(`config.exists:             ${signals.configExists.toString()}`);
  lines.push(`config.parses:             ${signals.configParses.toString()}`);
  lines.push(`api_key_present:           ${signals.apiKeyPresent.toString()}`);
  lines.push(`service_unit_registered:   ${signals.serviceUnitRegistered.toString()}`);
  lines.push(`daemon_running:            ${signals.daemonRunning.toString()}`);
  lines.push('');
  lines.push('Sentinels:');
  lines.push(`  AUTH_FAILED:             ${signals.sentinels.authFailed.toString()}`);
  lines.push(`  BUFFER_FULL:             ${signals.sentinels.bufferFull.toString()}`);
  lines.push(`  SESSION_STOPPED:         ${signals.sentinels.sessionStopped.toString()}`);
  lines.push(`  UPDATE_AVAILABLE:        ${signals.sentinels.updateAvailable.toString()}`);
  lines.push('');
  lines.push('Buffer:');
  lines.push(`  pending_count:           ${signals.buffer.pendingCount.toString()}`);
  lines.push(`  pending_bytes:           ${signals.buffer.pendingBytes.toString()}`);
  lines.push(`  failed_count:            ${signals.buffer.failedCount.toString()}`);
  lines.push(`  quarantined_count:       ${signals.buffer.quarantinedCount.toString()}`);
  lines.push(`  receipt_count:           ${signals.buffer.receiptCount.toString()}`);
  lines.push(`  last_prune_at:           ${signals.buffer.lastPruneAt ?? 'null'}`);
  lines.push(`  last_success_at:         ${signals.buffer.lastSuccessAt ?? 'null'}`);
  lines.push('');
  lines.push('Daemon state:');
  lines.push(`  capture_last_cycle_at:   ${signals.daemonState.captureLastCycleAt ?? 'null'}`);
  lines.push(`  drain_last_cycle_at:     ${signals.daemonState.drainLastCycleAt ?? 'null'}`);
  lines.push(
    `  retriable_break:         ${signals.daemonState.lastConsecutiveRetriableBreak === null ? 'null' : signals.daemonState.lastConsecutiveRetriableBreak.toString()}`,
  );
  lines.push('');
  lines.push('Binary:');
  lines.push(`  version:                 ${signals.binary.version}`);
  lines.push(`  mtime:                   ${signals.binary.mtime?.toISOString() ?? 'null'}`);
  lines.push(`  install_source:          ${signals.binary.installSource ?? 'null'}`);
  lines.push('');
  lines.push('Recent events:');
  lines.push(`  auth_unconfirmed:        ${signals.recentEvents.authUnconfirmedCount.toString()}`);
  lines.push(`  rate_limited:            ${signals.recentEvents.rateLimitedCount.toString()}`);
  lines.push(`  retriable:               ${signals.recentEvents.retriableCount.toString()}`);
  lines.push(
    `  validation_errors:       ${signals.recentEvents.fatalValidationErrorCount.toString()}`,
  );
  lines.push(`  auto_upgrade_events:     [${signals.recentEvents.autoUpgradeEvents.join(', ')}]`);
  lines.push('');
  lines.push('Filesystem:');
  lines.push(`  config_dir_writable:     ${signals.filesystem.configDirWritable.toString()}`);
  lines.push(`  log_dir_writable:        ${signals.filesystem.logDirWritable.toString()}`);
  lines.push(
    `  disk_free_bytes:         ${signals.filesystem.diskFreeBytes?.toString() ?? 'null'}`,
  );
  lines.push('');
  lines.push('Network:');
  lines.push(
    `  nest_reachable:          ${signals.network.nestReachable === null ? 'null' : signals.network.nestReachable.toString()}`,
  );
  lines.push('');
  lines.push('Source paths:');
  lines.push(`  claude_code_exists:      ${signals.sourcePaths.claudeCodeExists.toString()}`);
  lines.push(`  cursor_exists:           ${signals.sourcePaths.cursorExists.toString()}`);
  lines.push(`  codex_exists:            ${signals.sourcePaths.codexExists.toString()}`);
  lines.push(`  gemini_cli_exists:       ${signals.sourcePaths.geminiCliExists.toString()}`);
  lines.push('');
  lines.push('Resync events:');
  lines.push(`  total_count:             ${signals.resyncEvents.totalCount.toString()}`);
  if (signals.resyncEvents.regressionLoops.length > 0) {
    lines.push('  regression_loops:');
    for (const loop of signals.resyncEvents.regressionLoops) {
      lines.push(`    ${loop.sourcePathHash}: ${loop.countInLastHour.toString()} in last hour`);
    }
  }
  if (signals.systemdLingerEnabled !== null) {
    lines.push(`  systemd_linger:          ${signals.systemdLingerEnabled.toString()}`);
  }
  if (signals.macOsQuarantineXattr !== null) {
    lines.push(`  macos_quarantine:        ${signals.macOsQuarantineXattr.toString()}`);
  }
  if (signals.clockSkewMs !== null) {
    lines.push(`  clock_skew_ms:           ${signals.clockSkewMs.toString()}`);
  }
  return lines.join('\n');
}

const HEALTHY_CHECKS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'A1', label: 'Config present' },
  { code: 'A2', label: 'Service unit registered' },
  { code: 'A3/A4', label: 'Daemon running' },
  { code: 'B1', label: 'No AUTH_FAILED sentinel' },
  { code: 'B2', label: 'No auth-unconfirmed loop' },
  { code: 'C2', label: 'Nest endpoint reachable' },
  { code: 'F1', label: 'configDir writable' },
  { code: 'F2', label: 'Disk space adequate' },
];

export function renderDoctorOutput(findings: readonly Finding[], signals: DoctorSignals): string {
  const sorted = sortFindings(findings);
  const lines: string[] = [];

  lines.push('=== proxai-gateway doctor ===');
  lines.push('');

  if (sorted.length === 0) {
    lines.push('No issues found.');
    lines.push('');
    lines.push('Healthy checks:');
    for (const check of HEALTHY_CHECKS) {
      lines.push(`  [OK] ${check.code} ${check.label}`);
    }
  } else {
    const criticals = sorted.filter((f) => f.severity === Severity.critical);
    const warnings = sorted.filter((f) => f.severity === Severity.warning);
    const infos = sorted.filter((f) => f.severity === Severity.info);

    if (criticals.length > 0) {
      lines.push(`CRITICAL (${criticals.length.toString()})`);
      for (const f of criticals) {
        lines.push(renderFinding(f));
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push(`WARNING (${warnings.length.toString()})`);
      for (const f of warnings) {
        lines.push(renderFinding(f));
      }
      lines.push('');
    }

    if (infos.length > 0) {
      lines.push(`INFO (${infos.length.toString()})`);
      for (const f of infos) {
        lines.push(renderFinding(f));
      }
      lines.push('');
    }

    const findingCodes = new Set(sorted.map((f) => f.code));
    const passingChecks = HEALTHY_CHECKS.filter(
      (c) => !findingCodes.has(c.code as Finding['code']),
    );
    if (passingChecks.length > 0) {
      lines.push('Passing checks:');
      for (const check of passingChecks) {
        lines.push(`  [OK] ${check.code} ${check.label}`);
      }
      lines.push('');
    }
  }

  lines.push('');
  lines.push(renderSignalsAppendix(signals));

  return lines.join('\n');
}
