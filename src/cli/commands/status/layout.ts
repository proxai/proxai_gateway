import chalk from 'chalk';

import { formatBytes } from 'core/utils';

export const KEY_WIDTH = 14;
export const SUB_LABEL_WIDTH = 12;
export const COUNT_COL = 5;
export const BYTES_COL = 9;

export function keyCol(label: string): string {
  return label.padEnd(KEY_WIDTH);
}

export function summaryHeadline(count: number, bytes: number, headline: string): string {
  const c = count.toString().padStart(COUNT_COL);
  const b = formatBytes(bytes).padStart(BYTES_COL);
  return `${c} ${chalk.dim('batches')}    (${b})        ${chalk.dim(headline)}`;
}

export function subRow(label: string, count: number, bytes: number): string {
  const c = count.toString().padStart(COUNT_COL);
  const b = formatBytes(bytes).padStart(BYTES_COL);
  return `    ${chalk.dim('·')} ${label.padEnd(SUB_LABEL_WIDTH)}${c} ${chalk.dim('batches')}    (${b})`;
}
