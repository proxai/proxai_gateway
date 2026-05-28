import chalk from 'chalk';

import { formatBytes, formatRelative, formatLocalTimestamp } from 'core/utils';
import type {
  FailedRecord,
  LogsCommandDeps,
  LogsCommandOptions,
  LogsFrame,
  PendingRecord,
  QuarantinedRecord,
  UploadedRecord,
} from 'cli/commands/logs/logs.types.ts';

const TRUNCATE_PATH = 48;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function shortPath(p: string): string {
  return truncate(p, TRUNCATE_PATH);
}

function renderUploadedRow(row: UploadedRecord, isDevMode: boolean): string {
  const time = formatLocalTimestamp(row.deliveredAt);
  const rel = formatRelative(row.deliveredAt);
  const reuse = row.idempotentOnServer ? chalk.dim(' (re-sent)') : '';
  const source = chalk.cyan(row.sourceApp);
  if (isDevMode) {
    return `${chalk.dim(time)} (${rel})  ${source}  ${chalk.dim(row.captureId)}  hash:${row.sourcePathHash.slice(0, 8)}…${reuse}`;
  }
  return `${chalk.dim(time)} (${rel})  ${source}${reuse}`;
}

function renderFailedRow(row: FailedRecord): string {
  const time = formatLocalTimestamp(row.capturedAtUtc);
  const rel = formatRelative(row.capturedAtUtc);
  const source = chalk.yellow(row.sourceApp);
  const attempts = chalk.dim(`attempts: ${row.attempts.toString()}`);
  const errText = row.lastError !== null ? chalk.red(truncate(row.lastError, 80)) : '';
  const path = chalk.dim(shortPath(row.sourcePath));
  return `${chalk.dim(time)} (${rel})  ${source}  ${path}  ${attempts}${errText.length > 0 ? `  ${errText}` : ''}`;
}

function renderQuarantinedRow(row: QuarantinedRecord): string {
  const time = formatLocalTimestamp(row.quarantinedAtUtc);
  const rel = formatRelative(row.quarantinedAtUtc);
  const source = chalk.magenta(row.sourceApp);
  const size = chalk.dim(formatBytes(row.redactedSizeBytes));
  const path = chalk.dim(shortPath(row.sourcePath));
  const reason = chalk.red(truncate(row.reason, 60));
  return `${chalk.dim(time)} (${rel})  ${source}  ${path}  ${size}  ${reason}`;
}

function renderPendingRow(row: PendingRecord): string {
  const time = formatLocalTimestamp(row.capturedAtUtc);
  const rel = formatRelative(row.capturedAtUtc);
  const source = chalk.blue(row.sourceApp);
  const path = chalk.dim(shortPath(row.sourcePath));
  const attempts = row.attempts > 0 ? chalk.dim(` attempts:${row.attempts.toString()}`) : '';
  return `${chalk.dim(time)} (${rel})  ${source}  ${path}${attempts}`;
}

export function renderLogsFrame(
  frame: LogsFrame,
  options: LogsCommandOptions,
  deps: LogsCommandDeps,
): string {
  const lines: string[] = [];

  if (frame.uploaded.length > 0) {
    lines.push(chalk.bold('Uploaded'));
    for (const row of frame.uploaded) {
      lines.push('  ' + renderUploadedRow(row, deps.isDevMode));
    }
  }

  if (frame.failed.length > 0) {
    lines.push(chalk.bold(chalk.yellow('Failed')));
    for (const row of frame.failed) {
      lines.push('  ' + renderFailedRow(row));
    }
  }

  if (frame.quarantined.length > 0) {
    lines.push(chalk.bold(chalk.red('Quarantined')));
    for (const row of frame.quarantined) {
      lines.push('  ' + renderQuarantinedRow(row));
    }
  }

  if (frame.pending.length > 0) {
    lines.push(chalk.bold(chalk.blue('Pending')));
    for (const row of frame.pending) {
      lines.push('  ' + renderPendingRow(row));
    }
  }

  const isEmpty =
    frame.uploaded.length === 0 &&
    frame.failed.length === 0 &&
    frame.quarantined.length === 0 &&
    frame.pending.length === 0;

  if (isEmpty) {
    const mode = options.error === true ? 'No errors found.' : options.pending === true ? 'No pending records.' : 'No uploaded records yet.';
    lines.push(chalk.dim(mode));
  }

  return lines.join('\n');
}

export function renderLogsJson(frame: LogsFrame): string {
  return JSON.stringify(frame);
}
