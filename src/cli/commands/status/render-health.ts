import chalk from 'chalk';

import { formatDuration, formatTimeWithRelative } from 'core/utils';
import type { InstallSource } from 'services/config';

import { sectionHeader } from 'cli/commands/status/decorators.ts';
import { keyCol } from 'cli/commands/status/layout.ts';

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
