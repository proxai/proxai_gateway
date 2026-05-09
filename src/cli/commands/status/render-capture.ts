import chalk from 'chalk';

import { formatRelative } from 'core/utils';

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
