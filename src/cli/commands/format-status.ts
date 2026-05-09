import chalk from 'chalk';

import type { CountsBySource, DaemonStateSnapshot } from 'services/buffer';
import type { InstallSource } from 'services/config';

export interface RelativeTimeOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatLocalTimestamp(iso: string, options: RelativeTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const formatter = new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    timeZone: options.timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(ms));
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const day = lookup['day'] ?? '';
  const month = lookup['month'] ?? '';
  const hour = lookup['hour'] ?? '';
  const minute = lookup['minute'] ?? '';
  const second = lookup['second'] ?? '';
  const monthKnown = MONTH_SHORT.includes(month) ? month : monthFromIso(ms);
  return `${day} ${monthKnown} ${hour}:${minute}:${second}`;
}

function monthFromIso(ms: number): string {
  const d = new Date(ms);
  return MONTH_SHORT[d.getUTCMonth()] ?? '';
}

export function formatRelative(iso: string, options: RelativeTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const nowMs = (options.now ?? new Date()).getTime();
  const diff = nowMs - ms;
  if (diff < 0) {
    return formatRelativePositive(-diff, true);
  }
  return formatRelativePositive(diff, false);
}

function formatRelativePositive(diff: number, future: boolean): string {
  const suffix = future ? 'from now' : 'ago';
  if (diff < MS_PER_MINUTE) {
    const s = Math.max(1, Math.floor(diff / MS_PER_SECOND));
    return `${s.toString()}s ${suffix}`;
  }
  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MINUTE);
    return `${m.toString()} min ${suffix}`;
  }
  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR);
    return `${h.toString()} h ${suffix}`;
  }
  const d = Math.floor(diff / MS_PER_DAY);
  return `${d.toString()} d ${suffix}`;
}

export function formatTimeWithRelative(iso: string, options: RelativeTimeOptions = {}): string {
  const ts = formatLocalTimestamp(iso, options);
  const rel = formatRelative(iso, options);
  return rel.length > 0 ? `${ts} (${rel})` : ts;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n.toString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return `${rounded} ${units[unitIdx] ?? 'B'}`;
}

export type StatusHealth = 'healthy' | 'warning' | 'error' | 'inactive';

export function statusDot(health: StatusHealth): string {
  if (health === 'healthy') return chalk.green('●');
  if (health === 'warning') return chalk.yellow('●');
  if (health === 'error') return chalk.red('●');
  return chalk.dim('○');
}

export function sectionHeader(label: string): string {
  return `── ${chalk.bold(label)} ──`;
}

export function deriveHealth(deps: {
  paused: boolean;
  authFailed: boolean;
  bufferFull: boolean;
  sessionStopped: boolean;
  hasRecentActivity: boolean;
  drain: DaemonStateSnapshot | null;
}): StatusHealth {
  if (deps.authFailed || deps.paused || deps.bufferFull || deps.sessionStopped) return 'error';
  if (!deps.hasRecentActivity) return 'inactive';
  if (
    deps.drain !== null &&
    deps.drain.lastDrainRetriable !== null &&
    deps.drain.lastDrainRetriable > 0
  ) {
    return 'warning';
  }
  return 'healthy';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms).toString()} ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec.toString()} s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin.toString()} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours < 24) return `${hours.toString()}h ${minutes.toString()}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days.toString()}d ${remHours.toString()}h`;
}

export function formatPercent(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%';
  const pct = (value / total) * 100;
  if (pct < 1 && pct > 0) return '<1%';
  return `${Math.round(pct).toString()}%`;
}

export interface CaptureSourceSummary {
  name: string;
  capturedBatches: number;
  filesProcessed: number;
  errorsCount: number;
}

const SOURCE_LABEL_PAD = 14;

export function renderCaptureCyclesLine(
  total: number,
  withErrors: number,
  lastAt: string | null,
  now: Date,
): string {
  const parts: string[] = [];
  parts.push(`${total.toString()} ${chalk.dim('completed')}`);
  if (lastAt !== null) {
    parts.push(`last ${formatRelative(lastAt, { now })}`);
  } else {
    parts.push(chalk.dim('no cycles yet'));
  }
  if (withErrors > 0) {
    parts.push(chalk.yellow(`${withErrors.toString()} with errors`));
  } else {
    parts.push(`${withErrors.toString()} ${chalk.dim('with errors')}`);
  }
  return parts.join('  ' + chalk.dim('·') + '  ');
}

export function renderCaptureRow(s: CaptureSourceSummary): string {
  const padded = s.name.padEnd(SOURCE_LABEL_PAD);
  const captured = s.capturedBatches.toString().padStart(4);
  const files = s.filesProcessed.toString().padStart(4);
  const errors = s.errorsCount;
  const errorsStr =
    errors === 0 ? `${errors.toString()} errors` : chalk.yellow(`${errors.toString()} errors`);
  return `  ${padded}${captured} captured   /  ${files} files scanned   /  ${errorsStr}`;
}

export interface BufferSectionInput {
  pendingCount: number;
  pendingBytes: number;
  failedCount: number;
  failedBytes: number;
  receiptsCount: number;
  pressurePendingBytes: number;
  pressureSoftPauseBytes: number;
  lastPruneAt: string | null;
  bySource: CountsBySource | null;
  now: Date;
}

const KEY_WIDTH = 14;
const SUB_LABEL_WIDTH = 12;
const COUNT_COL = 5;
const BYTES_COL = 9;

function keyCol(label: string): string {
  return label.padEnd(KEY_WIDTH);
}

function summaryHeadline(count: number, bytes: number, headline: string): string {
  const c = count.toString().padStart(COUNT_COL);
  const b = formatBytes(bytes).padStart(BYTES_COL);
  return `${c} ${chalk.dim('batches')}    (${b})        ${chalk.dim(headline)}`;
}

function subRow(label: string, count: number, bytes: number): string {
  const c = count.toString().padStart(COUNT_COL);
  const b = formatBytes(bytes).padStart(BYTES_COL);
  return `    ${chalk.dim('·')} ${label.padEnd(SUB_LABEL_WIDTH)}${c} ${chalk.dim('batches')}    (${b})`;
}

export function renderBufferSection(input: BufferSectionInput): string[] {
  const lines: string[] = [sectionHeader('Buffer')];
  lines.push(
    `  ${keyCol('Pending')}${summaryHeadline(input.pendingCount, input.pendingBytes, 'held for delivery')}`,
  );
  if (input.bySource !== null && input.pendingCount > 0) {
    for (const [name, c] of Object.entries(input.bySource)) {
      if (c.pending > 0) {
        lines.push(subRow(name, c.pending, c.pendingBytes));
      }
    }
  }
  lines.push(
    `  ${keyCol('Failed')}${summaryHeadline(input.failedCount, input.failedBytes, 'permanent errors retained for review')}`,
  );
  if (input.bySource !== null && input.failedCount > 0) {
    for (const [name, c] of Object.entries(input.bySource)) {
      if (c.failed > 0) {
        lines.push(subRow(name, c.failed, c.failedBytes));
      }
    }
  }
  lines.push(
    `  ${keyCol('Receipts')}${input.receiptsCount.toString().padStart(COUNT_COL)} ${chalk.dim('records')}                ${chalk.dim('delivery confirmations on file')}`,
  );
  const pct = formatPercent(input.pressurePendingBytes, input.pressureSoftPauseBytes);
  lines.push(
    `  ${keyCol('Pressure')}${formatBytes(input.pressurePendingBytes)} / ${formatBytes(input.pressureSoftPauseBytes)}  (${pct} ${chalk.dim('of soft-pause threshold')})`,
  );
  if (input.lastPruneAt !== null) {
    lines.push(
      `  ${keyCol('Last prune')}${formatTimeWithRelative(input.lastPruneAt, { now: input.now })}`,
    );
  } else {
    lines.push(`  ${keyCol('Last prune')}${chalk.dim('never')}`);
  }
  return lines;
}

export interface UploadSourceTotals {
  batches: number;
  bytes: number;
}

export type UploadBySource = Record<string, UploadSourceTotals>;

export interface UploadSectionInput {
  totalBatchesShipped: number;
  totalBytesShipped: number;
  drainCyclesTotal: number;
  drainCyclesTotalDurationMs: number;
  shippedBySource: UploadBySource | null;
  lastCycleCompletedAt: string | null;
  lastCycleAttempted: number | null;
  lastCycleAccepted: number | null;
  lastCycleRetriable: number | null;
  lastCycleFatal: number | null;
  lastSuccessAt: string | null;
  lastSuccessBatches: number | null;
  lastSuccessBytes: number | null;
  now: Date;
}

export function renderUploadSection(input: UploadSectionInput): string[] {
  const lines: string[] = [sectionHeader('Upload')];

  if (input.drainCyclesTotal > 0 || input.totalBatchesShipped > 0) {
    const c = input.totalBatchesShipped.toString().padStart(COUNT_COL);
    const b = formatBytes(input.totalBytesShipped).padStart(BYTES_COL);
    const cy = input.drainCyclesTotal.toString();
    lines.push(
      `  ${keyCol('All-time')}${c} ${chalk.dim('batches shipped')}   ·   ${b} ${chalk.dim('compressed')}   ·   ${cy} ${chalk.dim('drain cycles')}`,
    );

    if (input.shippedBySource !== null) {
      for (const [name, totals] of Object.entries(input.shippedBySource)) {
        if (totals.batches > 0) {
          lines.push(subRow(name, totals.batches, totals.bytes));
        }
      }
    }
  } else {
    lines.push(`  ${keyCol('All-time')}${chalk.dim('— no drain cycles completed yet')}`);
  }

  if (input.drainCyclesTotal > 0) {
    const avgBatches = input.totalBatchesShipped / input.drainCyclesTotal;
    const avgBytes = input.totalBytesShipped / input.drainCyclesTotal;
    const avgMs = input.drainCyclesTotalDurationMs / input.drainCyclesTotal;
    const ab = avgBatches.toFixed(1).padStart(COUNT_COL);
    const aby = formatBytes(avgBytes).padStart(BYTES_COL);
    const ams = formatDuration(avgMs);
    lines.push(
      `  ${keyCol('Avg / drain')}${ab} ${chalk.dim('batches')}        ·   ${aby} ${chalk.dim('compressed')}   ·   ${ams}`,
    );
  } else {
    lines.push(`  ${keyCol('Avg / drain')}${chalk.dim('— no drain cycles yet')}`);
  }

  if (input.lastCycleCompletedAt !== null) {
    const attempted = input.lastCycleAttempted ?? 0;
    const accepted = input.lastCycleAccepted ?? 0;
    const retriable = input.lastCycleRetriable ?? 0;
    const fatal = input.lastCycleFatal ?? 0;
    const retriableStr =
      retriable > 0
        ? chalk.yellow(`${retriable.toString()} retriable`)
        : `${retriable.toString()} retriable`;
    const fatalStr =
      fatal > 0 ? chalk.red(`${fatal.toString()} fatal`) : `${fatal.toString()} fatal`;
    lines.push(
      `  ${keyCol('Last drain')}${formatTimeWithRelative(input.lastCycleCompletedAt, { now: input.now })}   ${chalk.dim('·')}  ${attempted.toString()} attempted   ${accepted.toString()} accepted   ${retriableStr}   ${fatalStr}`,
    );
  } else {
    lines.push(`  ${keyCol('Last drain')}${chalk.dim('— no drain completed yet')}`);
  }

  if (input.lastSuccessAt !== null) {
    const batches = input.lastSuccessBatches ?? 0;
    const bytes = input.lastSuccessBytes ?? 0;
    lines.push(
      `  ${keyCol('Last success')}${formatTimeWithRelative(input.lastSuccessAt, { now: input.now })}   ${chalk.dim('·')}  ${batches.toString()} batches      ${formatBytes(bytes)} shipped`,
    );
  } else {
    lines.push(`  ${keyCol('Last success')}${chalk.dim('— no successful upload yet')}`);
  }

  return lines;
}

export interface HealthDaemonInput {
  isRunning: boolean;
  pid: number | null;
  startedAt: Date | null;
  now: Date;
  installSource: InstallSource | null;
}

export interface ActiveSentinels {
  paused: boolean;
  authFailed: boolean;
  bufferFull: boolean;
  sessionStopped: boolean;
  updateAvailable: boolean;
}

export interface AutoUpgradeInput {
  lastCheckAt: string | null;
  currentVersion: string;
  latestKnownVersion: string | null;
  installSource: InstallSource | null;
  updateAvailableSentinelPresent: boolean;
  now: Date;
}

export interface BinaryAgeInput {
  installedAt: string | null;
  warnAfterDays: number;
  pauseAfterDays: number;
  now: Date;
}

export function renderHealthSection(input: {
  daemon: HealthDaemonInput;
  sentinels: ActiveSentinels;
  autoUpgrade: AutoUpgradeInput;
  binaryAge: BinaryAgeInput;
}): string[] {
  const lines: string[] = [sectionHeader('Health')];
  lines.push(`  ${keyCol('Daemon')}${renderDaemonLine(input.daemon)}`);
  lines.push(`  ${keyCol('Sentinels')}${renderSentinelsLine(input.sentinels)}`);
  lines.push(`  ${keyCol('Auto-upgrade')}${renderAutoUpgradeLine(input.autoUpgrade)}`);
  lines.push(`  ${keyCol('Binary age')}${renderBinaryAgeLine(input.binaryAge)}`);
  return lines;
}

function renderDaemonLine(d: HealthDaemonInput): string {
  if (!d.isRunning) return chalk.dim('not running');
  const parts: string[] = [];
  if (d.pid !== null) parts.push(`pid ${d.pid.toString()}`);
  if (d.startedAt !== null) {
    const ms = d.now.getTime() - d.startedAt.getTime();
    if (ms >= 0) parts.push(`uptime ${formatDuration(ms)}`);
  }
  const detail = parts.length === 0 ? '' : `  (${parts.join(', ')})`;
  return `${chalk.green('running')}${detail}`;
}

function renderSentinelsLine(s: ActiveSentinels): string {
  const active: string[] = [];
  if (s.paused) active.push('paused');
  if (s.authFailed) active.push('auth-failed');
  if (s.bufferFull) active.push('buffer-full');
  if (s.sessionStopped) active.push('session-stopped');
  if (s.updateAvailable) active.push('update-available');
  if (active.length === 0) return chalk.dim('none active');
  return chalk.yellow(active.join(', '));
}

function renderAutoUpgradeLine(a: AutoUpgradeInput): string {
  const parts: string[] = [];
  if (a.lastCheckAt !== null) {
    parts.push(`last check ${formatTimeWithRelative(a.lastCheckAt, { now: a.now })}`);
  } else {
    parts.push('last check ' + chalk.dim('never'));
  }
  parts.push(`current ${a.currentVersion}`);
  if (a.latestKnownVersion !== null) {
    parts.push(`latest ${a.latestKnownVersion}`);
  }
  let suffix = '';
  if (a.latestKnownVersion !== null) {
    if (a.latestKnownVersion === a.currentVersion) {
      suffix = `  (${chalk.green('up to date')})`;
    } else if (a.updateAvailableSentinelPresent) {
      suffix = `  (${chalk.yellow('update pending')})`;
    } else {
      suffix = `  (${chalk.yellow('update queued for next cycle')})`;
    }
  }
  return `${parts.join('  ' + chalk.dim('·') + '  ')}${suffix}`;
}

function renderBinaryAgeLine(b: BinaryAgeInput): string {
  if (b.installedAt === null) return chalk.dim('unknown');
  const ms = Date.parse(b.installedAt);
  if (!Number.isFinite(ms)) return chalk.dim('unknown');
  const days = Math.floor((b.now.getTime() - ms) / 86_400_000);
  const baseDays = days < 0 ? 0 : days;
  const tail = `(warn ≥ ${b.warnAfterDays.toString()} d, pause ≥ ${b.pauseAfterDays.toString()} d)`;
  if (baseDays >= b.pauseAfterDays)
    return `${chalk.red(`${baseDays.toString()} days`)}  ${chalk.dim(tail)}`;
  if (baseDays >= b.warnAfterDays)
    return `${chalk.yellow(`${baseDays.toString()} days`)}  ${chalk.dim(tail)}`;
  return `${baseDays.toString()} days  ${chalk.dim(tail)}`;
}
