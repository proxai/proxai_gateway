import { Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';
import { formatLocalTimestamp } from 'core/utils/format.ts';
import chalk from 'chalk';

function localTime(iso: string | null): string | null {
  return iso === null ? null : formatLocalTimestamp(iso);
}

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
  lines.push(`  last_prune_at:           ${formatStr(localTime(signals.buffer.lastPruneAt))}`);
  lines.push(`  last_success_at:         ${formatStr(localTime(signals.buffer.lastSuccessAt))}`);
  lines.push('');
  lines.push('Daemon state:');
  lines.push(
    `  capture_last_cycle_at:   ${formatStr(localTime(signals.daemonState.captureLastCycleAt))}`,
  );
  lines.push(
    `  drain_last_cycle_at:     ${formatStr(localTime(signals.daemonState.drainLastCycleAt))}`,
  );
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
    `  mtime:                   ${formatStr(localTime(signals.binary.mtime?.toISOString() ?? null))}`,
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

const PROXAI_THEME = {
  pageBg: '#020c0c',
  cardBg: '#071717',
  codeBg: '#0e2424',
  borderBase: '#122a2a',
  borderStrong: '#1a3c3c',
  text: '#f3f4f6',
  textSecondary: '#9ca3af',
  textMuted: '#6b7280',
  mint: '#4ade80',
  cyan: '#22d3ee',
  amber: '#fbbf24',
  rose: '#fb7185',
  blue: '#60a5fa',
} as const;

const DARK_POLYGONS: ReadonlyArray<readonly [string, string]> = [
  ['#888', '90 150 0 300 180 300'],
  ['', '90 150 180 0 0 0'],
  ['#555', '270 150 360 0 180 0'],
  ['#333', '450 150 360 300 540 300'],
  ['#666', '450 150 540 0 360 0'],
  ['', '630 150 540 300 720 300'],
  ['#333', '630 150 720 0 540 0'],
  ['#888', '810 150 720 300 900 300'],
  ['#111', '810 150 900 0 720 0'],
  ['#333', '990 150 900 300 1080 300'],
  ['#888', '990 150 1080 0 900 0'],
  ['#333', '90 450 0 600 180 600'],
  ['', '90 450 180 300 0 300'],
  ['#999', '270 450 180 600 360 600'],
  ['#555', '270 450 360 300 180 300'],
  ['#333', '450 450 360 600 540 600'],
  ['#666', '450 450 540 300 360 300'],
  ['#666', '630 450 540 600 720 600'],
  ['#111', '630 450 720 300 540 300'],
  ['', '810 450 720 600 900 600'],
  ['#333', '810 450 900 300 720 300'],
  ['#555', '990 450 900 600 1080 600'],
  ['#888', '990 450 1080 300 900 300'],
  ['#DDD', '90 750 0 900 180 900'],
  ['', '270 750 180 900 360 900'],
  ['#333', '270 750 360 600 180 600'],
  ['', '450 750 540 600 360 600'],
  ['', '630 750 540 900 720 900'],
  ['#888', '630 750 720 600 540 600'],
  ['#555', '810 750 720 900 900 900'],
  ['#999', '810 750 900 600 720 600'],
  ['#666', '990 750 900 900 1080 900'],
  ['#666', '180 0 90 150 270 150'],
  ['#888', '360 0 270 150 450 150'],
  ['#111', '540 0 450 150 630 150'],
  ['', '900 0 810 150 990 150'],
  ['#DDD', '0 300 -90 450 90 450'],
  ['#111', '0 300 90 150 -90 150'],
  ['#111', '180 300 90 450 270 450'],
  ['#999', '180 300 270 150 90 150'],
  ['#DDD', '360 300 270 450 450 450'],
  ['#111', '360 300 450 150 270 150'],
  ['#888', '540 300 450 450 630 450'],
  ['#DDD', '540 300 630 150 450 150'],
  ['#555', '720 300 630 450 810 450'],
  ['#999', '720 300 810 150 630 150'],
  ['#111', '900 300 810 450 990 450'],
  ['#666', '900 300 990 150 810 150'],
  ['', '0 600 -90 750 90 750'],
  ['#999', '0 600 90 450 -90 450'],
  ['#555', '180 600 90 750 270 750'],
  ['#888', '180 600 270 450 90 450'],
  ['#888', '360 600 270 750 450 750'],
  ['#666', '360 600 450 450 270 450'],
  ['#999', '540 600 630 450 450 450'],
  ['#DDD', '720 600 630 750 810 750'],
  ['#111', '900 600 810 750 990 750'],
  ['#DDD', '900 600 990 450 810 450'],
  ['#333', '0 900 90 750 -90 750'],
  ['#888', '180 900 270 750 90 750'],
  ['#111', '360 900 450 750 270 750'],
  ['#555', '540 900 630 750 450 750'],
  ['#111', '720 900 810 750 630 750'],
  ['#DDD', '900 900 990 750 810 750'],
  ['#DDD', '1080 300 990 450 1170 450'],
  ['#111', '1080 300 1170 150 990 150'],
  ['', '1080 600 990 750 1170 750'],
  ['#999', '1080 600 1170 450 990 450'],
  ['#333', '1080 900 1170 750 990 750'],
];

function buildBackgroundTile(): string {
  const polygons = DARK_POLYGONS.map(
    ([fill, points]) => `<polygon${fill ? ` fill="${fill}"` : ''} points="${points}"/>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="450" viewBox="0 0 1080 900" preserveAspectRatio="xMidYMid slice"><rect width="100%" height="100%" fill="${PROXAI_THEME.pageBg}"/><g opacity="0.3"><g fill-opacity="0.05" fill="#ffffff">${polygons}</g></g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

const BACKGROUND_TILE_DATA_URI = buildBackgroundTile();

function htmlBool(value: boolean): string {
  return value ? '<span class="v-true">true</span>' : '<span class="v-false">false</span>';
}

function htmlNullableBool(value: boolean | null): string {
  return value === null ? '<span class="v-null">null</span>' : htmlBool(value);
}

function htmlStr(value: string | null): string {
  return value === null
    ? '<span class="v-null">null</span>'
    : `<span class="v-str">${escapeHtml(value)}</span>`;
}

function htmlNum(value: number): string {
  return `<span class="v-num">${value.toString()}</span>`;
}

function htmlNullableNum(value: number | null): string {
  return value === null ? '<span class="v-null">null</span>' : htmlNum(value);
}

function htmlEvents(events: readonly string[]): string {
  if (events.length === 0) {
    return '<span class="v-null">none</span>';
  }
  return events
    .map((e) => `<span class="v-str">${escapeHtml(e)}</span>`)
    .join('<span class="v-null">, </span>');
}

function htmlRegressionLoops(
  loops: ReadonlyArray<{ readonly sourcePathHash: string; readonly countInLastHour: number }>,
): string {
  if (loops.length === 0) {
    return '<span class="v-null">none</span>';
  }
  return loops
    .map(
      (loop) =>
        `<span class="v-str">${escapeHtml(loop.sourcePathHash)}</span> <span class="v-null">·</span> <span class="v-num">${loop.countInLastHour.toString()}</span><span class="v-null">/h</span>`,
    )
    .join('<br>');
}

function sigRow(key: string, valueHtml: string): string {
  return `<div class="row"><span class="k">${key}</span><span class="v">${valueHtml}</span></div>`;
}

function sigCard(title: string, rows: readonly string[]): string {
  return `<section class="card"><h3 class="card-title">${title}</h3><div class="rows">${rows.join('')}</div></section>`;
}

function renderFindingCard(finding: Finding): string {
  let kind = 'info';
  if (finding.severity === Severity.critical) {
    kind = 'crit';
  } else if (finding.severity === Severity.warning) {
    kind = 'warn';
  }
  return `<article class="finding finding-${kind}">
            <div class="finding-head">
              <span class="finding-code">${escapeHtml(finding.code)}</span>
              <span class="finding-conf">${finding.confidence}</span>
            </div>
            <p class="finding-cause">${escapeHtml(finding.cause)}</p>
            <p class="finding-action"><span class="arrow">→</span><span>${escapeHtml(finding.action)}</span></p>
          </article>`;
}

function findingGroup(label: string, kind: string, items: readonly Finding[]): string {
  if (items.length === 0) {
    return '';
  }
  return `<div class="group">
          <h3 class="group-title group-${kind}"><span class="dot"></span>${label} (${items.length.toString()})</h3>
          ${items.map(renderFindingCard).join('')}
        </div>`;
}

function renderHealthBanner(criticals: number, warnings: number, infos: number): string {
  const total = criticals + warnings + infos;
  if (total === 0) {
    return `<div class="health health-ok"><span class="pip"></span><span class="health-text">All systems healthy<span class="health-sub"> — no issues detected</span></span></div>`;
  }
  const parts: string[] = [];
  if (criticals > 0) {
    parts.push(`${criticals.toString()} critical`);
  }
  if (warnings > 0) {
    parts.push(`${warnings.toString()} warning`);
  }
  if (infos > 0) {
    parts.push(`${infos.toString()} info`);
  }
  return `<div class="health health-bad"><span class="pip"></span><span class="health-text">${total.toString()} issue${total === 1 ? '' : 's'} found<span class="health-sub"> — ${parts.join(' · ')}</span></span></div>`;
}

export function generateDoctorHtml(
  findings: readonly Finding[],
  signals: DoctorSignals,
  timestamp: string,
): string {
  const sorted = sortFindings(findings);
  const criticals = sorted.filter((f) => f.severity === Severity.critical);
  const warnings = sorted.filter((f) => f.severity === Severity.warning);
  const infos = sorted.filter((f) => f.severity === Severity.info);

  const summaryBody =
    sorted.length === 0
      ? `<div class="healthy"><div class="mark">✓</div><div class="msg">System is completely healthy. No issues found!</div></div>`
      : `${findingGroup('Critical Issues', 'crit', criticals)}${findingGroup('Warnings', 'warn', warnings)}${findingGroup('Info', 'info', infos)}`;

  const cards = [
    sigCard('Core State', [
      sigRow('platform', htmlStr(signals.platform)),
      sigRow('config.exists', htmlBool(signals.configExists)),
      sigRow('config.parses', htmlBool(signals.configParses)),
      sigRow('api_key_present', htmlBool(signals.apiKeyPresent)),
      sigRow('service_unit_registered', htmlBool(signals.serviceUnitRegistered)),
      sigRow('daemon_running', htmlBool(signals.daemonRunning)),
    ]),
    sigCard('Sentinels', [
      sigRow('AUTH_FAILED', htmlBool(signals.sentinels.authFailed)),
      sigRow('BUFFER_FULL', htmlBool(signals.sentinels.bufferFull)),
      sigRow('SESSION_STOPPED', htmlBool(signals.sentinels.sessionStopped)),
      sigRow('UPDATE_AVAILABLE', htmlBool(signals.sentinels.updateAvailable)),
    ]),
    sigCard('Buffer', [
      sigRow('pending_count', htmlNum(signals.buffer.pendingCount)),
      sigRow('pending_bytes', htmlNum(signals.buffer.pendingBytes)),
      sigRow('failed_count', htmlNum(signals.buffer.failedCount)),
      sigRow('quarantined_count', htmlNum(signals.buffer.quarantinedCount)),
      sigRow('receipt_count', htmlNum(signals.buffer.receiptCount)),
      sigRow('last_prune_at', htmlStr(localTime(signals.buffer.lastPruneAt))),
      sigRow('last_success_at', htmlStr(localTime(signals.buffer.lastSuccessAt))),
    ]),
    sigCard('Daemon State', [
      sigRow('capture_last_cycle', htmlStr(localTime(signals.daemonState.captureLastCycleAt))),
      sigRow('drain_last_cycle', htmlStr(localTime(signals.daemonState.drainLastCycleAt))),
      sigRow(
        'retriable_break',
        htmlNullableBool(signals.daemonState.lastConsecutiveRetriableBreak),
      ),
      sigRow('last_upload_error', htmlStr(signals.daemonState.lastUploadError)),
    ]),
    sigCard('Binary', [
      sigRow('version', htmlStr(signals.binary.version)),
      sigRow('mtime', htmlStr(localTime(signals.binary.mtime?.toISOString() ?? null))),
      sigRow('install_source', htmlStr(signals.binary.installSource)),
    ]),
    sigCard('Recent Events', [
      sigRow('auth_unconfirmed', htmlNum(signals.recentEvents.authUnconfirmedCount)),
      sigRow('rate_limited', htmlNum(signals.recentEvents.rateLimitedCount)),
      sigRow('retriable', htmlNum(signals.recentEvents.retriableCount)),
      sigRow('validation_errors', htmlNum(signals.recentEvents.fatalValidationErrorCount)),
      sigRow('auto_upgrade_events', htmlEvents(signals.recentEvents.autoUpgradeEvents)),
    ]),
    sigCard('Filesystem', [
      sigRow('config_dir_writable', htmlBool(signals.filesystem.configDirWritable)),
      sigRow('log_dir_writable', htmlBool(signals.filesystem.logDirWritable)),
      sigRow('disk_free_bytes', htmlNullableNum(signals.filesystem.diskFreeBytes)),
    ]),
    sigCard('Network', [sigRow('nest_reachable', htmlNullableBool(signals.network.nestReachable))]),
    sigCard('Source Paths', [
      sigRow('claude_code_exists', htmlBool(signals.sourcePaths.claudeCodeExists)),
      sigRow('cursor_exists', htmlBool(signals.sourcePaths.cursorExists)),
      sigRow('codex_exists', htmlBool(signals.sourcePaths.codexExists)),
      sigRow('gemini_cli_exists', htmlBool(signals.sourcePaths.geminiCliExists)),
    ]),
    sigCard('Host & Resync', [
      sigRow('resync_total', htmlNum(signals.resyncEvents.totalCount)),
      sigRow('regression_loops', htmlRegressionLoops(signals.resyncEvents.regressionLoops)),
      sigRow('systemd_linger', htmlNullableBool(signals.systemdLingerEnabled)),
      sigRow('macos_quarantine', htmlNullableBool(signals.macOsQuarantineXattr)),
      sigRow('clock_skew_ms', htmlNullableNum(signals.clockSkewMs)),
    ]),
  ].join('');

  const T = PROXAI_THEME;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProxAI Gateway — Doctor Diagnostics</title>
  <style>
    :root {
      --page: ${T.pageBg};
      --card: ${T.cardBg};
      --card-2: ${T.codeBg};
      --border: ${T.borderBase};
      --border-strong: ${T.borderStrong};
      --text: ${T.text};
      --text-2: ${T.textSecondary};
      --muted: ${T.textMuted};
      --mint: ${T.mint};
      --cyan: ${T.cyan};
      --amber: ${T.amber};
      --rose: ${T.rose};
      --blue: ${T.blue};
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      --mono: 'Menlo', 'Monaco', 'Courier New', monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background-color: var(--page);
      background-image: url("${BACKGROUND_TILE_DATA_URI}");
      background-repeat: repeat;
      color: var(--text);
      font-family: var(--font);
      -webkit-font-smoothing: antialiased;
      line-height: 1.5;
      font-size: 15px;
    }
    .wrap { max-width: 920px; margin: 0 auto; padding: 0 24px; }
    .band {
      background-color: var(--page);
      border-bottom: 1px solid var(--border);
      padding: 40px 24px 32px;
      text-align: center;
    }
    .wordmark {
      font-size: 44px;
      font-weight: 400;
      letter-spacing: -0.01em;
      line-height: 1;
      color: var(--text);
    }
    .eyebrow {
      margin-top: 16px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--mint);
    }
    .band-meta { margin-top: 10px; font-size: 13px; color: var(--muted); }
    .band-meta .ts { color: var(--text-2); font-family: var(--mono); }
    main { padding: 40px 0 60px; }
    .health {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 22px;
      border-radius: 14px;
      border: 1px solid var(--border-strong);
      background-color: var(--card);
      margin-bottom: 44px;
    }
    .health-ok { border-color: rgba(74, 222, 128, 0.45); background-color: rgba(74, 222, 128, 0.06); }
    .health-bad { border-color: rgba(251, 113, 133, 0.45); background-color: rgba(251, 113, 133, 0.06); }
    .health .pip { width: 11px; height: 11px; border-radius: 50%; flex: 0 0 auto; }
    .health-ok .pip { background-color: var(--mint); box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.15); }
    .health-bad .pip { background-color: var(--rose); box-shadow: 0 0 0 4px rgba(251, 113, 133, 0.15); }
    .health-text { font-size: 15px; font-weight: 600; color: var(--text); }
    .health-sub { font-weight: 400; color: var(--text-2); }
    .block { margin-bottom: 48px; }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-2);
      margin: 0 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .group { margin-bottom: 26px; }
    .group-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin: 0 0 14px;
    }
    .group-title .dot { width: 9px; height: 9px; border-radius: 50%; }
    .group-crit { color: var(--rose); } .group-crit .dot { background-color: var(--rose); }
    .group-warn { color: var(--amber); } .group-warn .dot { background-color: var(--amber); }
    .group-info { color: var(--blue); } .group-info .dot { background-color: var(--blue); }
    .finding {
      padding: 18px 20px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background-color: var(--card);
      margin-bottom: 12px;
    }
    .finding-crit { border-left: 3px solid var(--rose); }
    .finding-warn { border-left: 3px solid var(--amber); }
    .finding-info { border-left: 3px solid var(--blue); }
    .finding-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .finding-code {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
      background-color: var(--card-2);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 3px 9px;
      letter-spacing: 0.04em;
    }
    .finding-conf {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .finding-cause { margin: 0 0 8px; font-size: 15px; font-weight: 500; color: var(--text); }
    .finding-action {
      margin: 0;
      font-size: 14px;
      color: var(--mint);
      font-weight: 500;
      display: flex;
      gap: 8px;
    }
    .finding-action .arrow { color: var(--muted); }
    .healthy {
      padding: 36px 24px;
      text-align: center;
      border-radius: 16px;
      border: 1px solid rgba(74, 222, 128, 0.3);
      background-color: rgba(74, 222, 128, 0.05);
    }
    .healthy .mark { font-size: 34px; color: var(--mint); line-height: 1; }
    .healthy .msg { margin-top: 12px; font-size: 17px; font-weight: 700; color: var(--mint); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 18px;
    }
    .card {
      background-color: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 22px;
    }
    .card-title {
      margin: 0 0 14px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--mint);
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .rows { display: flex; flex-direction: column; gap: 9px; }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 16px;
    }
    .row .k { color: var(--text); font-family: var(--mono); font-size: 12.5px; }
    .row .v {
      font-family: var(--mono);
      font-size: 12.5px;
      text-align: right;
      word-break: break-word;
    }
    .v-true { color: var(--mint); font-weight: 600; }
    .v-false { color: var(--rose); font-weight: 600; }
    .v-null { color: var(--muted); }
    .v-num { color: var(--cyan); }
    .v-str { color: var(--amber); }
    footer {
      border-top: 1px solid var(--border);
      padding: 26px 24px 44px;
      text-align: center;
      font-size: 12px;
      color: var(--muted);
    }
    footer .sep { margin: 0 8px; color: var(--border-strong); }
  </style>
</head>
<body>
  <header class="band">
    <div class="wordmark">ProxAI</div>
    <div class="eyebrow">Gateway · Doctor Diagnostics</div>
    <div class="band-meta">Report compiled <span class="ts">${escapeHtml(timestamp)}</span> · v${escapeHtml(signals.binary.version)}</div>
  </header>

  <main>
    <div class="wrap">
      ${renderHealthBanner(criticals.length, warnings.length, infos.length)}

      <section class="block">
        <h2 class="section-title">Diagnostics Summary</h2>
        ${summaryBody}
      </section>

      <section class="block">
        <h2 class="section-title">Signals Appendix</h2>
        <div class="grid">${cards}</div>
      </section>
    </div>
  </main>

  <footer>
    ProxAI Gateway<span class="sep">·</span>Diagnostics Report<span class="sep">·</span>v${escapeHtml(signals.binary.version)}
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
