import { Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';
import chalk from 'chalk';

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
  const codeText = chalk.bold(finding.code);
  const causeText = chalk.white(finding.cause);
  const actionText = chalk.cyan.bold(finding.action);

  let prefix = '';
  if (finding.severity === Severity.critical) {
    prefix = chalk.bold.red('  [X] ');
  } else if (finding.severity === Severity.warning) {
    prefix = chalk.bold.yellow('  [!] ');
  } else {
    prefix = chalk.bold.blue('  [i] ');
  }

  return `${prefix}${codeText} ${causeText}\n     ${chalk.dim('->')} ${actionText}`;
}

function centerText(text: string, width: number): string {
  if (text.length >= width) {
    return text;
  }
  const padding = Math.floor((width - text.length) / 2);
  return ' '.repeat(padding) + text;
}

function renderSignalsAppendix(signals: DoctorSignals, width: number): string {
  const lines: string[] = [];
  lines.push('═'.repeat(width));
  lines.push(centerText('SIGNALS', width));
  lines.push('═'.repeat(width));

  const formatBool = (val: boolean) => (val ? chalk.green('true') : chalk.red('false'));
  const formatStr = (val: string | null) => (val !== null ? chalk.yellow(val) : chalk.dim('null'));
  const formatNum = (val: number) => chalk.magenta(val.toString());

  lines.push(`platform:                  ${chalk.blue(signals.platform)}`);
  lines.push(`config.exists:             ${formatBool(signals.configExists)}`);
  lines.push(`config.parses:             ${formatBool(signals.configParses)}`);
  lines.push(`api_key_present:           ${formatBool(signals.apiKeyPresent)}`);
  lines.push(`service_unit_registered:   ${formatBool(signals.serviceUnitRegistered)}`);
  lines.push(`daemon_running:            ${formatBool(signals.daemonRunning)}`);
  lines.push('');
  lines.push('Sentinels:');
  lines.push(`  AUTH_FAILED:             ${formatBool(signals.sentinels.authFailed)}`);
  lines.push(`  BUFFER_FULL:             ${formatBool(signals.sentinels.bufferFull)}`);
  lines.push(`  SESSION_STOPPED:         ${formatBool(signals.sentinels.sessionStopped)}`);
  lines.push(`  UPDATE_AVAILABLE:        ${formatBool(signals.sentinels.updateAvailable)}`);
  lines.push('');
  lines.push('Buffer:');
  lines.push(`  pending_count:           ${formatNum(signals.buffer.pendingCount)}`);
  lines.push(`  pending_bytes:           ${formatNum(signals.buffer.pendingBytes)}`);
  lines.push(`  failed_count:            ${formatNum(signals.buffer.failedCount)}`);
  lines.push(`  quarantined_count:       ${formatNum(signals.buffer.quarantinedCount)}`);
  lines.push(`  receipt_count:           ${formatNum(signals.buffer.receiptCount)}`);
  lines.push(`  last_prune_at:           ${formatStr(signals.buffer.lastPruneAt)}`);
  lines.push(`  last_success_at:         ${formatStr(signals.buffer.lastSuccessAt)}`);
  lines.push('');
  lines.push('Daemon state:');
  lines.push(`  capture_last_cycle_at:   ${formatStr(signals.daemonState.captureLastCycleAt)}`);
  lines.push(`  drain_last_cycle_at:     ${formatStr(signals.daemonState.drainLastCycleAt)}`);
  lines.push(
    `  retriable_break:         ${signals.daemonState.lastConsecutiveRetriableBreak === null ? chalk.dim('null') : formatBool(signals.daemonState.lastConsecutiveRetriableBreak)}`,
  );
  if (signals.daemonState.lastUploadError !== null) {
    lines.push(`  last_upload_error:       ${formatStr(signals.daemonState.lastUploadError)}`);
  }
  lines.push('');
  lines.push('Binary:');
  lines.push(`  version:                 ${chalk.yellow(signals.binary.version)}`);
  lines.push(
    `  mtime:                   ${formatStr(signals.binary.mtime?.toISOString() ?? null)}`,
  );
  lines.push(`  install_source:          ${formatStr(signals.binary.installSource)}`);
  lines.push('');
  lines.push('Recent events:');
  lines.push(`  auth_unconfirmed:        ${formatNum(signals.recentEvents.authUnconfirmedCount)}`);
  lines.push(`  rate_limited:            ${formatNum(signals.recentEvents.rateLimitedCount)}`);
  lines.push(`  retriable:               ${formatNum(signals.recentEvents.retriableCount)}`);
  lines.push(
    `  validation_errors:       ${formatNum(signals.recentEvents.fatalValidationErrorCount)}`,
  );
  lines.push(
    `  auto_upgrade_events:     [${signals.recentEvents.autoUpgradeEvents.map((e) => chalk.yellow(e)).join(', ')}]`,
  );
  lines.push('');
  lines.push('Filesystem:');
  lines.push(`  config_dir_writable:     ${formatBool(signals.filesystem.configDirWritable)}`);
  lines.push(`  log_dir_writable:        ${formatBool(signals.filesystem.logDirWritable)}`);
  lines.push(
    `  disk_free_bytes:         ${signals.filesystem.diskFreeBytes !== null ? chalk.magenta(signals.filesystem.diskFreeBytes.toString()) : chalk.dim('null')}`,
  );
  lines.push('');
  lines.push('Network:');
  lines.push(
    `  nest_reachable:          ${signals.network.nestReachable === null ? chalk.dim('null') : formatBool(signals.network.nestReachable)}`,
  );
  lines.push('');
  lines.push('Source paths:');
  lines.push(`  claude_code_exists:      ${formatBool(signals.sourcePaths.claudeCodeExists)}`);
  lines.push(`  cursor_exists:           ${formatBool(signals.sourcePaths.cursorExists)}`);
  lines.push(`  codex_exists:            ${formatBool(signals.sourcePaths.codexExists)}`);
  lines.push(`  gemini_cli_exists:       ${formatBool(signals.sourcePaths.geminiCliExists)}`);
  lines.push('');
  lines.push('Resync events:');
  lines.push(`  total_count:             ${formatNum(signals.resyncEvents.totalCount)}`);
  if (signals.resyncEvents.regressionLoops.length > 0) {
    lines.push('  regression_loops:');
    for (const loop of signals.resyncEvents.regressionLoops) {
      lines.push(`    ${loop.sourcePathHash}: ${formatNum(loop.countInLastHour)} in last hour`);
    }
  } else {
    lines.push(`  regression_loops:        ${chalk.dim('none')}`);
  }
  lines.push(
    `  systemd_linger:          ${signals.systemdLingerEnabled === null ? chalk.dim('null') : formatBool(signals.systemdLingerEnabled)}`,
  );
  lines.push(
    `  macos_quarantine:        ${signals.macOsQuarantineXattr === null ? chalk.dim('null') : formatBool(signals.macOsQuarantineXattr)}`,
  );
  lines.push(
    `  clock_skew_ms:           ${signals.clockSkewMs === null ? chalk.dim('null') : formatNum(signals.clockSkewMs)}`,
  );

  return lines.join('\n');
}

function renderSummaryBlock(sorted: readonly Finding[]): string[] {
  const lines: string[] = [];

  if (sorted.length === 0) {
    lines.push('No issues found.');
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
  }

  return lines;
}

export function renderDoctorOutput(findings: readonly Finding[], signals: DoctorSignals): string {
  const sorted = sortFindings(findings);
  const lines: string[] = [];

  lines.push('=== proxai-gateway doctor ===');
  lines.push('');

  const summaryBlock = renderSummaryBlock(sorted);
  const width = process.stdout.columns || 60;

  lines.push(renderSignalsAppendix(signals, width));
  lines.push('');

  lines.push('═'.repeat(width));
  lines.push(centerText('DIAGNOSTICS SUMMARY', width));
  lines.push('═'.repeat(width));
  lines.push('');
  lines.push(...summaryBlock);

  return lines.join('\n');
}

export function generateDoctorHtml(
  findings: readonly Finding[],
  signals: DoctorSignals,
  timestamp: string,
): string {
  const sorted = sortFindings(findings);

  const renderHtmlFinding = (f: Finding) => {
    let badgeClass = '';
    let icon = '';
    if (f.severity === Severity.critical) {
      badgeClass = 'bg-red-500/10 text-red-400 border-red-500/30';
      icon = '[X]';
    } else if (f.severity === Severity.warning) {
      badgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      icon = '[!]';
    } else {
      badgeClass = 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      icon = '[i]';
    }
    return `
      <div class="p-5 mb-4 rounded-xl border bg-slate-800/50 border-slate-700/50 hover:border-slate-600 transition duration-200">
        <div class="flex items-center gap-3 mb-2">
          <span class="px-2.5 py-1 text-xs font-semibold tracking-wider uppercase rounded-full border ${badgeClass}">
            ${icon} [${f.confidence}] ${f.code}
          </span>
        </div>
        <p class="text-base text-slate-100 font-medium mb-2">${escapeHtml(f.cause)}</p>
        <div class="text-sm text-cyan-400 font-semibold flex items-start gap-2">
          <span class="text-slate-500">→</span>
          <span>${escapeHtml(f.action)}</span>
        </div>
      </div>
    `;
  };

  const criticals = sorted.filter((f) => f.severity === Severity.critical);
  const warnings = sorted.filter((f) => f.severity === Severity.warning);
  const infos = sorted.filter((f) => f.severity === Severity.info);

  const buildSummaryHtml = () => {
    let html = '';
    if (sorted.length === 0) {
      html += `
        <div class="p-6 text-center rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-emerald-400 mb-8">
          <span class="text-3xl mb-2 block">✓</span>
          <span class="font-bold text-lg">System is completely healthy. No issues found!</span>
        </div>
      `;
    } else {
      if (criticals.length > 0) {
        html += `
          <div class="mb-8">
            <h3 class="text-sm font-bold uppercase tracking-wider text-red-400 mb-4 flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span>
              Critical Issues (${criticals.length})
            </h3>
            ${criticals.map(renderHtmlFinding).join('')}
          </div>
        `;
      }
      if (warnings.length > 0) {
        html += `
          <div class="mb-8">
            <h3 class="text-sm font-bold uppercase tracking-wider text-amber-400 mb-4 flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
              Warnings (${warnings.length})
            </h3>
            ${warnings.map(renderHtmlFinding).join('')}
          </div>
        `;
      }
      if (infos.length > 0) {
        html += `
          <div class="mb-8">
            <h3 class="text-sm font-bold uppercase tracking-wider text-blue-400 mb-4 flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
              Info (${infos.length})
            </h3>
            ${infos.map(renderHtmlFinding).join('')}
          </div>
        `;
      }
    }

    return html;
  };

  const summarySection = buildSummaryHtml();
  const formatHtmlBool = (v: boolean) =>
    v
      ? '<span class="text-emerald-400 font-bold">true</span>'
      : '<span class="text-red-400 font-bold">false</span>';
  const formatHtmlStr = (v: string | null) =>
    v !== null
      ? `<span class="text-amber-300">${escapeHtml(v)}</span>`
      : '<span class="text-slate-500">null</span>';
  const formatHtmlNum = (v: number) => `<span class="text-fuchsia-400">${v}</span>`;

  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProxAI Gateway - Doctor Diagnostics Report</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
    body {
      font-family: 'Outfit', sans-serif;
    }
    .font-mono {
      font-family: 'JetBrains Mono', monospace;
    }
  </style>
</head>
<body class="bg-slate-900 text-slate-200 h-full flex flex-col antialiased">
  <header class="bg-slate-950 border-b border-slate-800 py-8 px-6 text-center relative overflow-hidden shrink-0">
    <div class="absolute inset-0 bg-gradient-to-r from-cyan-500/10 via-fuchsia-500/10 to-emerald-500/10 opacity-30 pointer-events-none"></div>
    <div class="relative z-10 max-w-4xl mx-auto flex flex-col items-center">
      <div class="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center mb-4">
        <span class="text-2xl font-bold font-mono text-cyan-400">DR</span>
      </div>
      <h1 class="text-3xl font-extrabold tracking-tight text-white mb-2">PROXAI-GATEWAY DOCTOR</h1>
      <p class="text-sm text-slate-400">Diagnostic report compiled on <span class="text-cyan-400 font-medium font-mono">${timestamp}</span></p>
    </div>
  </header>

  <main class="flex-1 overflow-y-auto py-10 px-6">
    <div class="max-w-4xl mx-auto">
      <section class="mb-12">
        <h2 class="text-lg font-bold text-white mb-6 border-b border-slate-800 pb-2 flex items-center gap-2">
          Diagnostics Signals Appendix
        </h2>
        <div class="bg-slate-950 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-4 border-b border-slate-800 pb-2">Core State</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">platform:</span><span class="font-mono text-cyan-300">${signals.platform}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">config.exists:</span><span class="font-mono">${formatHtmlBool(signals.configExists)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">config.parses:</span><span class="font-mono">${formatHtmlBool(signals.configParses)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">api_key_present:</span><span class="font-mono">${formatHtmlBool(signals.apiKeyPresent)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">service_unit_registered:</span><span class="font-mono">${formatHtmlBool(signals.serviceUnitRegistered)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">daemon_running:</span><span class="font-mono">${formatHtmlBool(signals.daemonRunning)}</span></div>
              </div>

              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mt-6 mb-4 border-b border-slate-800 pb-2">Sentinels</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">AUTH_FAILED:</span><span class="font-mono">${formatHtmlBool(signals.sentinels.authFailed)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">BUFFER_FULL:</span><span class="font-mono">${formatHtmlBool(signals.sentinels.bufferFull)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">SESSION_STOPPED:</span><span class="font-mono">${formatHtmlBool(signals.sentinels.sessionStopped)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">UPDATE_AVAILABLE:</span><span class="font-mono">${formatHtmlBool(signals.sentinels.updateAvailable)}</span></div>
              </div>

              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mt-6 mb-4 border-b border-slate-800 pb-2">Filesystem</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">config_dir_writable:</span><span class="font-mono">${formatHtmlBool(signals.filesystem.configDirWritable)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">log_dir_writable:</span><span class="font-mono">${formatHtmlBool(signals.filesystem.logDirWritable)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">disk_free_bytes:</span><span class="font-mono">${signals.filesystem.diskFreeBytes !== null ? formatHtmlNum(signals.filesystem.diskFreeBytes) : '<span class="text-slate-500">null</span>'}</span></div>
              </div>
            </div>

            <div>
              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mb-4 border-b border-slate-800 pb-2">Buffer</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">pending_count:</span><span class="font-mono">${formatHtmlNum(signals.buffer.pendingCount)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">pending_bytes:</span><span class="font-mono">${formatHtmlNum(signals.buffer.pendingBytes)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">failed_count:</span><span class="font-mono">${formatHtmlNum(signals.buffer.failedCount)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">quarantined_count:</span><span class="font-mono">${formatHtmlNum(signals.buffer.quarantinedCount)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">receipt_count:</span><span class="font-mono">${formatHtmlNum(signals.buffer.receiptCount)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">last_prune_at:</span><span class="font-mono">${formatHtmlStr(signals.buffer.lastPruneAt)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">last_success_at:</span><span class="font-mono">${formatHtmlStr(signals.buffer.lastSuccessAt)}</span></div>
              </div>

              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mt-6 mb-4 border-b border-slate-800 pb-2">Daemon State Machine</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">capture_last_cycle:</span><span class="font-mono">${formatHtmlStr(signals.daemonState.captureLastCycleAt)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">drain_last_cycle:</span><span class="font-mono">${formatHtmlStr(signals.daemonState.drainLastCycleAt)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">last_upload_error:</span><span class="font-mono">${formatHtmlStr(signals.daemonState.lastUploadError)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">retriable_break:</span><span class="font-mono">${signals.daemonState.lastConsecutiveRetriableBreak === null ? '<span class="text-slate-500">null</span>' : formatHtmlBool(signals.daemonState.lastConsecutiveRetriableBreak)}</span></div>
              </div>

              <h3 class="text-xs font-bold uppercase tracking-wider text-cyan-400 mt-6 mb-4 border-b border-slate-800 pb-2">Binary</h3>
              <div class="space-y-2 text-sm">
                <div class="flex justify-between"><span class="text-slate-400">version:</span><span class="font-mono text-amber-300">${escapeHtml(signals.binary.version)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">mtime:</span><span class="font-mono">${formatHtmlStr(signals.binary.mtime?.toISOString() ?? null)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">install_source:</span><span class="font-mono">${formatHtmlStr(signals.binary.installSource)}</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="mb-8">
        <h2 class="text-lg font-bold text-white mb-6 border-b border-slate-800 pb-2 flex items-center gap-2">
          Diagnostics Summary
        </h2>
        ${summarySection}
      </section>
    </div>
  </main>

  <footer class="bg-slate-950 border-t border-slate-800 py-6 px-6 text-center text-xs text-slate-500 shrink-0">
    <div class="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
      <span>ProxAI Daemon State Machine Diagnostics v${escapeHtml(signals.binary.version)}</span>
      <span>Generated by Antigravity CLI</span>
    </div>
  </footer>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
