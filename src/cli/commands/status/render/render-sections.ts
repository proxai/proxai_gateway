import chalk from 'chalk';

import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTimeWithRelative,
} from 'core/utils';
import {
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  type InstallSource,
} from 'services/config';

import { formatSourceLabel } from 'cli/commands/status/layout.ts';
import {
  LABEL_WIDTH,
  rowBytes,
  rowCount,
  rowCountBytes,
  rowText,
  sectionDivider,
  subRowCountBytes,
} from 'cli/commands/status/render/format-rows.ts';
import type { LastUploadRow } from 'services/buffer';
import type { StatusSnapshot } from 'cli/commands/status/status.types.ts';

const PROMPT_SNIPPET_MAX = 80;

const SOURCE_ORDER: readonly (
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini-cli'
  | 'claude-desktop'
)[] = ['claude-code', 'cursor', 'codex', 'gemini-cli', 'claude-desktop'];

const SUB_LABEL_WIDTH = 14;

export function renderCaptureSection(s: StatusSnapshot): string[] {
  const lines: string[] = [sectionDivider('Capture')];
  for (const app of SOURCE_ORDER) {
    const cap = s.daemonState?.lastSourceCaptures[app];
    const captured = cap?.capturedBatches ?? 0;
    const files = cap?.filesProcessed ?? 0;
    const errors = cap?.errorsCount ?? 0;
    const errorsStr =
      errors === 0
        ? chalk.dim(`${errors.toString().padStart(2)} errors`)
        : chalk.yellow(`${errors.toString().padStart(2)} errors`);
    const label = formatSourceLabel(app);
    const c = chalk.bold(captured.toString().padStart(4));
    const f = chalk.dim(files.toString().padStart(4));
    lines.push(
      `  ${label.padEnd(LABEL_WIDTH)}${c} ${chalk.dim('captured  ')}${f} ${chalk.dim('files scanned  ')}${errorsStr}`,
    );
  }
  return lines;
}

export function renderBufferSection(s: StatusSnapshot): string[] {
  const softPause = s.cfg?.capture.bufferSoftPauseBytes ?? DEFAULT_BUFFER_SOFT_PAUSE_BYTES;
  const lines: string[] = [sectionDivider('Buffer')];

  lines.push(
    rowCountBytes('Pending', s.counts.pending, 'batches', s.pendingBytes, 'held for delivery'),
  );
  if (s.sourceCounts !== null && s.counts.pending > 0) {
    for (const [name, c] of Object.entries(s.sourceCounts)) {
      if (c.pending > 0) {
        lines.push(subRowCountBytes(formatSourceLabel(name), c.pending, 'batches', c.pendingBytes));
      }
    }
  }

  lines.push(
    rowCountBytes('Failed', s.counts.failed, 'batches', s.failedBytes, 'permanent errors'),
  );
  if (s.sourceCounts !== null && s.counts.failed > 0) {
    for (const [name, c] of Object.entries(s.sourceCounts)) {
      if (c.failed > 0) {
        lines.push(subRowCountBytes(formatSourceLabel(name), c.failed, 'batches', c.failedBytes));
      }
    }
  }

  lines.push(rowCount('Receipts', s.counts.delivered, 'records', 'delivery confirmations'));
  if (s.quarantinedCount > 0) {
    lines.push(rowCount('Quarantined', s.quarantinedCount, 'records', 'oversized rows skipped'));
  }

  const pct = formatPercent(s.pendingBytes, softPause);
  lines.push(rowBytes('Pressure', s.pendingBytes, softPause, `${pct} of soft-pause threshold`));

  if (s.lastPruneAt !== null) {
    lines.push(rowText('Last prune', formatTimeWithRelative(s.lastPruneAt, { now: s.now })));
  } else {
    lines.push(rowText('Last prune', chalk.dim('never')));
  }

  const cyclesLabel = `${chalk.bold(s.captureCyclesTotal.toString())} ${chalk.dim('completed')}`;
  const cyclesLast =
    s.captureLastCycleAt !== null
      ? `last ${formatRelative(s.captureLastCycleAt, { now: s.now })}`
      : chalk.dim('no cycles yet');
  const cyclesErrors =
    s.captureCyclesWithErrors > 0
      ? chalk.yellow(`${s.captureCyclesWithErrors.toString()} with errors`)
      : `${s.captureCyclesWithErrors.toString()} ${chalk.dim('with errors')}`;
  lines.push(
    rowText(
      'Cycles',
      `${cyclesLabel}  ${chalk.dim('·')}  ${cyclesLast}  ${chalk.dim('·')}  ${cyclesErrors}`,
    ),
  );

  return lines;
}

export function renderUploadSection(s: StatusSnapshot): string[] {
  const lines: string[] = [sectionDivider('Upload')];

  if (s.drainCyclesTotal > 0 || s.totalBatchesShipped > 0) {
    lines.push(
      rowCountBytes(
        'All-time',
        s.totalBatchesShipped,
        'batches',
        s.totalBytesShipped,
        `shipped · ${s.drainCyclesTotal.toString()} drain cycles`,
      ),
    );
    if (s.shippedBySource !== null) {
      for (const app of SOURCE_ORDER) {
        const totals = s.shippedBySource[app];
        if (totals !== undefined && totals.batches > 0) {
          lines.push(
            subRowCountBytes(formatSourceLabel(app), totals.batches, 'batches', totals.bytes),
          );
        }
      }
    }
  } else {
    lines.push(rowText('All-time', chalk.dim('no drain cycles yet')));
  }

  if (s.drainCyclesTotal > 0) {
    const avgBatches = s.totalBatchesShipped / s.drainCyclesTotal;
    const avgBytes = s.totalBytesShipped / s.drainCyclesTotal;
    const avgMs = s.drainCyclesTotalDurationMs / s.drainCyclesTotal;
    lines.push(
      rowText(
        'Avg / drain',
        `${chalk.bold(avgBatches.toFixed(1).padStart(6))} ${chalk.dim('batches  ')}${chalk.dim(formatBytes(avgBytes).padStart(10))}  ${chalk.dim('·')}  ${formatDuration(avgMs)}`,
      ),
    );
  } else {
    lines.push(rowText('Avg / drain', chalk.dim('no drain cycles yet')));
  }

  if (s.daemonState !== null && s.daemonState.lastCycleCompletedAt !== null) {
    const attempted = s.daemonState.lastDrainAttempted ?? 0;
    const accepted = s.daemonState.lastDrainAccepted ?? 0;
    const retriable = s.daemonState.lastDrainRetriable ?? 0;
    const fatal = s.daemonState.lastDrainFatal ?? 0;
    const retriableStr =
      retriable > 0
        ? chalk.yellow(`${retriable.toString()} retriable`)
        : `${retriable.toString()} ${chalk.dim('retriable')}`;
    const fatalStr =
      fatal > 0
        ? chalk.red(`${fatal.toString()} fatal`)
        : `${fatal.toString()} ${chalk.dim('fatal')}`;
    lines.push(
      rowText(
        'Last drain',
        `${formatTimeWithRelative(s.daemonState.lastCycleCompletedAt, { now: s.now })}  ${chalk.dim('·')}  ${attempted.toString()} ${chalk.dim('attempted')}  ${accepted.toString()} ${chalk.dim('accepted')}  ${retriableStr}  ${fatalStr}`,
      ),
    );
  } else {
    lines.push(rowText('Last drain', chalk.dim('no drain completed yet')));
  }

  if (s.lastSuccessAt !== null) {
    const batches = s.lastSuccessBatches ?? 0;
    const bytes = s.lastSuccessBytes ?? 0;
    lines.push(
      rowText(
        'Last success',
        `${formatTimeWithRelative(s.lastSuccessAt, { now: s.now })}  ${chalk.dim('·')}  ${batches.toString()} ${chalk.dim('batches')}  ${formatBytes(bytes)} ${chalk.dim('shipped')}`,
      ),
    );
  } else {
    lines.push(rowText('Last success', chalk.dim('no successful upload yet')));
  }

  if (s.daemonState !== null && s.daemonState.lastUploadError !== null) {
    lines.push(rowText('Last error', chalk.red(s.daemonState.lastUploadError)));
  }
  if (s.daemonState !== null && s.daemonState.lastConsecutiveRetriableBreak === true) {
    lines.push(
      `  ${chalk.yellow('!')} ${chalk.yellow('Drain backed off after consecutive retriable failures; will retry next cycle')}`,
    );
  }

  return lines;
}

export function renderHistorySection(s: StatusSnapshot): string[] {
  if (s.history === null) return [];
  const lines: string[] = [sectionDivider('History (All-Time)')];
  lines.push(
    rowText(
      'Captured',
      `${chalk.bold(formatBytes(s.history.totalBytesCaptured).padStart(8))}  ${chalk.dim('·')}  ${s.history.totalRecordsCaptured.toString().padStart(6)} ${chalk.dim('records')}`,
    ),
  );
  lines.push(
    rowText(
      'Sent',
      `${chalk.bold(formatBytes(s.history.totalBytesSent).padStart(8))}  ${chalk.dim('·')}  ${s.history.totalRecordsSent.toString().padStart(6)} ${chalk.dim('records')}`,
    ),
  );
  lines.push(rowText('Sources', ''));
  for (const app of SOURCE_ORDER) {
    const count = s.history.conversationsCaptured[app] ?? 0;
    let suffix = 'chats';
    if (app === 'cursor') suffix = 'workspaces';
    if (app === 'codex') suffix = 'threads / rollouts';
    lines.push(
      `    ${formatSourceLabel(app).padEnd(SUB_LABEL_WIDTH)}${count.toString().padStart(6)} ${chalk.dim(suffix)}`,
    );
  }
  return lines;
}

export function maskApiKey(key?: string | null): string {
  if (!key) return 'none';
  if (key.length <= 8) return '*****';
  return `${key.slice(0, 4)}*****${key.slice(-4)}`;
}

export function renderHealthSection(input: {
  s: StatusSnapshot;
  currentVersion: string;
  inferredAlive: boolean;
  isDevLike: boolean;
  isLocalBuild: boolean;
}): string[] {
  const s = input.s;
  const installSource: InstallSource | null = s.cfg?.account.installSource ?? null;
  const lines: string[] = [sectionDivider('Health')];
  lines.push(
    rowText(
      input.isDevLike ? 'Daemon' : 'App',
      renderDaemonLine(s, input.inferredAlive, input.isDevLike, input.isLocalBuild),
    ),
  );
  lines.push(
    rowText(
      input.isDevLike ? 'Sentinels' : 'Status flags',
      renderSentinelsLine(s, input.isDevLike),
    ),
  );
  lines.push(
    rowText('Auto-upgrade', renderAutoUpgradeLine(s, input.currentVersion, installSource)),
  );
  lines.push(rowText('Binary age', renderBinaryAgeLine(s)));
  lines.push(rowText('Ingestion Key', maskApiKey(s.cfg?.account.apiKey)));
  if (input.isDevLike && s.runtime.pid !== null) {
    lines.push(rowText('PID', chalk.dim(s.runtime.pid.toString())));
  }
  return lines;
}

function renderDaemonLine(
  s: StatusSnapshot,
  inferredAlive: boolean,
  isDevLike: boolean,
  isLocalBuild: boolean,
): string {
  if (s.runtime.isRunning) {
    const parts: string[] = [chalk.green('● running')];
    if (s.runtime.startedAt !== null) {
      const ms = s.now.getTime() - s.runtime.startedAt.getTime();
      if (ms >= 0) parts.push(chalk.dim(`uptime ${formatDuration(ms)}`));
    }
    return parts.join('  ');
  }
  if (inferredAlive) {
    const tag = isLocalBuild
      ? 'running (local build)'
      : isDevLike
        ? 'running (dev mode)'
        : 'running';
    return chalk.green(`● ${tag}`);
  }
  return chalk.red('○ not running');
}

function renderSentinelsLine(s: StatusSnapshot, isDevLike: boolean): string {
  const active: string[] = [];
  if (s.authFailed) active.push(isDevLike ? 'auth-failed' : 'authentication failed');
  if (s.bufferFull) active.push(isDevLike ? 'buffer-full' : 'buffer full');
  if (s.sessionStopped) active.push(isDevLike ? 'session-stopped' : 'stopped');
  if (s.updateAvailable !== null) active.push(isDevLike ? 'update-available' : 'update available');
  if (active.length === 0) return chalk.dim('○ none active');
  return chalk.yellow(`● ${active.join(', ')}`);
}

function renderAutoUpgradeLine(
  s: StatusSnapshot,
  currentVersion: string,
  _installSource: InstallSource | null,
): string {
  const parts: string[] = [];
  if (s.lastVersionCheckAt !== null) {
    parts.push(`last check ${formatTimeWithRelative(s.lastVersionCheckAt, { now: s.now })}`);
  } else {
    parts.push(`last check ${chalk.dim('never')}`);
  }
  parts.push(`current ${currentVersion}`);
  if (s.latestKnownVersion !== null) {
    parts.push(`latest ${s.latestKnownVersion}`);
  }
  let suffix = '';
  if (s.latestKnownVersion !== null) {
    if (s.latestKnownVersion === currentVersion) {
      suffix = `  ${chalk.dim('·')}  ${chalk.green('up to date')}`;
    } else if (s.updateAvailable !== null) {
      suffix = `  ${chalk.dim('·')}  ${chalk.yellow('update pending')}`;
    } else {
      suffix = `  ${chalk.dim('·')}  ${chalk.yellow('queued for next cycle')}`;
    }
  }
  return `${parts.join(`  ${chalk.dim('·')}  `)}${suffix}`;
}

function renderBinaryAgeLine(s: StatusSnapshot): string {
  const installedAt = s.cfg?.account.installedAt ?? null;
  const warnAfterDays = s.cfg?.staleBinary.warnAfterDays ?? DEFAULT_STALE_WARN_DAYS;
  const pauseAfterDays = s.cfg?.staleBinary.pauseAfterDays ?? DEFAULT_STALE_PAUSE_DAYS;
  if (installedAt === null) return chalk.dim('unknown');
  const ms = Date.parse(installedAt);
  if (!Number.isFinite(ms)) return chalk.dim('unknown');
  const days = Math.floor((s.now.getTime() - ms) / 86_400_000);
  const safeDays = days < 0 ? 0 : days;
  const tail = chalk.dim(
    `(warn ≥ ${warnAfterDays.toString()} d · pause ≥ ${pauseAfterDays.toString()} d)`,
  );
  if (safeDays >= pauseAfterDays) return `${chalk.red(`${safeDays.toString()} days`)}  ${tail}`;
  if (safeDays >= warnAfterDays) return `${chalk.yellow(`${safeDays.toString()} days`)}  ${tail}`;
  return `${safeDays.toString()} days  ${tail}`;
}

export function renderLastUploadsSection(s: StatusSnapshot): string[] {
  if (s.lastUploads.length === 0) return [];
  const lines: string[] = [sectionDivider('Last Uploads (last 12 months)')];

  const capturedLabel = formatBytes(s.capturedBytes);
  const uploadedLabel = `${s.counts.delivered.toString()} uploaded`;
  const pendingLabel = `${s.counts.pending.toString()} pending`;
  const summaryParts = [
    `${chalk.bold(capturedLabel)} captured`,
    `(${uploadedLabel}, ${pendingLabel})`,
  ];
  if (s.idempotentCount > 0) {
    summaryParts.push(chalk.dim(`(${s.idempotentCount.toString()} re-sent)`));
  }
  lines.push(rowText('Summary', summaryParts.join('  ')));

  for (const row of s.lastUploads) {
    lines.push(renderLastUploadRow(row, s.now));
  }

  return lines;
}

function renderLastUploadRow(row: LastUploadRow, now: Date): string {
  const when =
    row.userPromptAddedAt !== null
      ? formatRelative(row.userPromptAddedAt, { now })
      : formatRelative(row.deliveredAt, { now });
  const source = chalk.dim(row.sourceApp.padEnd(12));
  const bytes =
    row.shippedBytes !== null
      ? chalk.dim(formatBytes(row.shippedBytes).padStart(8))
      : chalk.dim('        ');
  const prompt =
    row.userPrompt !== null
      ? chalk.dim(
          row.userPrompt.length > PROMPT_SNIPPET_MAX
            ? `${row.userPrompt.slice(0, PROMPT_SNIPPET_MAX)}…`
            : row.userPrompt,
        )
      : '';
  return `    ${when.padEnd(14)}  ${source}  ${bytes}  ${prompt}`;
}

export function renderResyncNote(s: StatusSnapshot): string[] {
  if (s.resyncCount === 0) return [];
  const lastStr =
    s.lastResyncAt !== null ? formatTimeWithRelative(s.lastResyncAt, { now: s.now }) : '';
  const note = `Re-synced with server: ${s.resyncCount.toString()} times, last ${lastStr}`;
  return [`  ${chalk.dim(note)}`];
}
