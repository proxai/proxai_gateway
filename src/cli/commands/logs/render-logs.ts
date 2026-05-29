import { isAbsolute, relative } from 'node:path';
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function shortPath(path: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (path.length <= maxLen) return path;
  if (maxLen <= 5) {
    return path.slice(0, maxLen - 1) + '…';
  }

  const ellipsis = '…';
  const remainingSpace = maxLen - ellipsis.length;
  const startLen = Math.floor(remainingSpace / 2);
  const endLen = Math.ceil(remainingSpace / 2);

  return path.slice(0, startLen) + ellipsis + path.slice(path.length - endLen);
}

function getRelativePath(p: string | null | undefined): string {
  if (!p) return '';
  return isAbsolute(p) ? relative(process.cwd(), p) : p;
}

function renderUploadedRow(row: UploadedRecord, showDevDetails: boolean, columns: number): string {
  const time = formatLocalTimestamp(row.deliveredAt);
  const rel = formatRelative(row.deliveredAt);
  const reuse = row.idempotentOnServer ? chalk.dim(' (re-sent)') : '';
  const source = chalk.cyan(row.sourceApp);

  const relPart = ` (${rel})`;
  const reusePart = row.idempotentOnServer ? ' (re-sent)' : '';
  const sourcePart = row.sourceApp;

  let otherLen = 2 + time.length + relPart.length + 2 + sourcePart.length + reusePart.length;

  if (showDevDetails) {
    const capturePart = row.captureId;
    const hashPart = `  hash:${row.sourcePathHash}`;
    otherLen += 2 + capturePart.length + 2 + hashPart.length;
  }

  const maxPathLen = Math.max(15, columns - otherLen);
  const pathStr = row.sourcePath ? shortPath(getRelativePath(row.sourcePath), maxPathLen) : '';
  const pathPart = pathStr ? `  ${chalk.dim(pathStr)}` : '';

  if (showDevDetails) {
    return `${chalk.dim(time)} (${rel})  ${source}  ${chalk.dim(row.captureId)}${pathPart}  hash:${row.sourcePathHash}${reuse}`;
  }

  return `${chalk.dim(time)} (${rel})  ${source}${pathPart}${reuse}`;
}

function renderFailedRow(row: FailedRecord, showDevDetails: boolean, columns: number): string {
  const time = formatLocalTimestamp(row.capturedAtUtc);
  const rel = formatRelative(row.capturedAtUtc);
  const source = chalk.yellow(row.sourceApp);
  const attempts = chalk.dim(`attempts: ${row.attempts.toString()}`);
  const errText = row.lastError !== null ? chalk.red(truncate(row.lastError, 80)) : '';

  const relPart = ` (${rel})`;
  const sourcePart = row.sourceApp;
  const attemptsPart = `  attempts: ${row.attempts.toString()}`;
  const errPart = row.lastError !== null ? `  ${truncate(row.lastError, 80)}` : '';

  let otherLen =
    2 +
    time.length +
    relPart.length +
    2 +
    sourcePart.length +
    2 +
    attemptsPart.length +
    errPart.length;

  if (showDevDetails) {
    const capturePart = row.captureId;
    const hashPart = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    otherLen += 2 + capturePart.length + 2 + hashPart.length;
  }

  const maxPathLen = Math.max(15, columns - otherLen);
  const path = chalk.dim(shortPath(getRelativePath(row.sourcePath), maxPathLen));

  if (showDevDetails) {
    const hashPartChalk = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    return `${chalk.dim(time)} (${rel})  ${source}  ${chalk.dim(row.captureId)}  ${path}${hashPartChalk}  ${attempts}${errText.length > 0 ? `  ${errText}` : ''}`;
  }

  return `${chalk.dim(time)} (${rel})  ${source}  ${path}  ${attempts}${errText.length > 0 ? `  ${errText}` : ''}`;
}

function renderQuarantinedRow(
  row: QuarantinedRecord,
  showDevDetails: boolean,
  columns: number,
): string {
  const time = formatLocalTimestamp(row.quarantinedAtUtc);
  const rel = formatRelative(row.quarantinedAtUtc);
  const source = chalk.magenta(row.sourceApp);
  const size = chalk.dim(formatBytes(row.redactedSizeBytes));
  const reason = chalk.red(truncate(row.reason, 60));

  const relPart = ` (${rel})`;
  const sourcePart = row.sourceApp;
  const sizePart = `  ${formatBytes(row.redactedSizeBytes)}`;
  const reasonPart = `  ${truncate(row.reason, 60)}`;

  let otherLen =
    2 +
    time.length +
    relPart.length +
    2 +
    sourcePart.length +
    2 +
    sizePart.length +
    2 +
    reasonPart.length;

  if (showDevDetails) {
    const idPart = `id:${row.id.toString()}`;
    const hashPart = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    otherLen += 2 + idPart.length + 2 + hashPart.length;
  }

  const maxPathLen = Math.max(15, columns - otherLen);
  const path = chalk.dim(shortPath(getRelativePath(row.sourcePath), maxPathLen));

  if (showDevDetails) {
    const hashPartChalk = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    return `${chalk.dim(time)} (${rel})  ${source}  id:${row.id.toString()}  ${path}${hashPartChalk}  ${size}  ${reason}`;
  }

  return `${chalk.dim(time)} (${rel})  ${source}  ${path}  ${size}  ${reason}`;
}

function renderPendingRow(row: PendingRecord, showDevDetails: boolean, columns: number): string {
  const time = formatLocalTimestamp(row.capturedAtUtc);
  const rel = formatRelative(row.capturedAtUtc);
  const source = chalk.blue(row.sourceApp);
  const attempts = row.attempts > 0 ? chalk.dim(` attempts:${row.attempts.toString()}`) : '';

  const relPart = ` (${rel})`;
  const sourcePart = row.sourceApp;
  const attemptsPart = row.attempts > 0 ? ` attempts:${row.attempts.toString()}` : '';

  let otherLen = 2 + time.length + relPart.length + 2 + sourcePart.length + 2 + attemptsPart.length;

  if (showDevDetails) {
    const capturePart = row.captureId;
    const hashPart = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    otherLen += 2 + capturePart.length + 2 + hashPart.length;
  }

  const maxPathLen = Math.max(15, columns - otherLen);
  const path = chalk.dim(shortPath(getRelativePath(row.sourcePath), maxPathLen));

  if (showDevDetails) {
    const hashPartChalk = row.sourcePathHash ? `  hash:${row.sourcePathHash}` : '';
    return `${chalk.dim(time)} (${rel})  ${source}  ${chalk.dim(row.captureId)}  ${path}${hashPartChalk}${attempts}`;
  }

  return `${chalk.dim(time)} (${rel})  ${source}  ${path}${attempts}`;
}

export function renderLogsFrame(
  frame: LogsFrame,
  options: LogsCommandOptions,
  deps: LogsCommandDeps,
): string {
  const lines: string[] = [];
  const showDevDetails = deps.isDevMode && options.compact !== true;

  const columns =
    process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;

  if (frame.uploaded.length > 0) {
    lines.push(chalk.bold('Uploaded'));
    for (const row of frame.uploaded) {
      lines.push('  ' + renderUploadedRow(row, showDevDetails, columns));
    }
  }

  if (frame.failed.length > 0) {
    lines.push(chalk.bold(chalk.yellow('Failed')));
    for (const row of frame.failed) {
      lines.push('  ' + renderFailedRow(row, showDevDetails, columns));
    }
  }

  if (frame.quarantined.length > 0) {
    lines.push(chalk.bold(chalk.red('Quarantined')));
    for (const row of frame.quarantined) {
      lines.push('  ' + renderQuarantinedRow(row, showDevDetails, columns));
    }
  }

  if (frame.pending.length > 0) {
    lines.push(chalk.bold(chalk.blue('Pending')));
    for (const row of frame.pending) {
      lines.push('  ' + renderPendingRow(row, showDevDetails, columns));
    }
  }

  const isEmpty =
    frame.uploaded.length === 0 &&
    frame.failed.length === 0 &&
    frame.quarantined.length === 0 &&
    frame.pending.length === 0;

  if (isEmpty) {
    const mode =
      options.error === true
        ? 'No errors found.'
        : options.pending === true
          ? 'No pending records.'
          : 'No uploaded records yet.';
    lines.push(chalk.dim(mode));
  }

  if (options.static !== true && options.json !== true) {
    lines.push('');
    lines.push(`  ${chalk.dim('Press q or Esc to quit')}`);
  }

  return lines.join('\n');
}

export function renderLogsJson(frame: LogsFrame): string {
  return JSON.stringify(frame);
}
