import chalk from 'chalk';

import { formatBytes } from 'core/utils';

export const KEY_WIDTH = 19;
export const SUB_LABEL_WIDTH = 15;
export const COUNT_COL = 5;
export const BYTES_COL = 9;

export function formatSourceLabel(name: string): string {
  switch (name) {
    case 'claude-code':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor';
    case 'codex':
      return 'Codex';
    case 'gemini-cli':
      return 'Gemini CLI';
    default:
      return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

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
  const humanLabel = formatSourceLabel(label);
  return `    ${chalk.dim('·')} ${humanLabel.padEnd(SUB_LABEL_WIDTH)}${c} ${chalk.dim('batches')}    (${b})`;
}
