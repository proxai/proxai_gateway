import chalk from 'chalk';

import { formatBytes } from 'core/utils';

export const LABEL_WIDTH = 16;
export const COUNT_WIDTH = 6;
export const UNIT_WIDTH = 9;
export const BYTES_WIDTH = 10;
export const SUB_LABEL_WIDTH = 14;
export const ROW_INDENT = '  ';
export const SUB_ROW_INDENT = '    ';
export const SEP = chalk.dim('·');

export function labelCol(text: string): string {
  return text.padEnd(LABEL_WIDTH);
}

export function rowCount(label: string, count: number, unit: string, comment?: string): string {
  const c = chalk.bold(count.toString().padStart(COUNT_WIDTH));
  const u = chalk.dim(unit.padEnd(UNIT_WIDTH));
  const tail = comment === undefined ? '' : `  ${SEP}  ${chalk.dim(comment)}`;
  return `${ROW_INDENT}${labelCol(label)}${c} ${u}${tail}`;
}

export function rowCountBytes(
  label: string,
  count: number,
  unit: string,
  bytes: number,
  comment?: string,
): string {
  const c = chalk.bold(count.toString().padStart(COUNT_WIDTH));
  const u = chalk.dim(unit.padEnd(UNIT_WIDTH));
  const b = chalk.dim(formatBytes(bytes).padStart(BYTES_WIDTH));
  const tail = comment === undefined ? '' : `  ${SEP}  ${chalk.dim(comment)}`;
  return `${ROW_INDENT}${labelCol(label)}${c} ${u} ${b}${tail}`;
}

export function rowText(label: string, value: string, comment?: string): string {
  const tail = comment === undefined ? '' : `  ${SEP}  ${chalk.dim(comment)}`;
  return `${ROW_INDENT}${labelCol(label)}${value}${tail}`;
}

export function rowBytes(label: string, bytes: number, total: number, comment?: string): string {
  const usage = `${formatBytes(bytes)} / ${formatBytes(total)}`;
  const tail = comment === undefined ? '' : `  ${SEP}  ${chalk.dim(comment)}`;
  return `${ROW_INDENT}${labelCol(label)}${chalk.bold(usage)}${tail}`;
}

export function subRowCountBytes(
  label: string,
  count: number,
  unit: string,
  bytes: number,
): string {
  const c = count.toString().padStart(COUNT_WIDTH);
  const u = chalk.dim(unit.padEnd(UNIT_WIDTH));
  const b = chalk.dim(formatBytes(bytes).padStart(BYTES_WIDTH));
  return `${SUB_ROW_INDENT}${label.padEnd(SUB_LABEL_WIDTH)}${c} ${u} ${b}`;
}

export function sectionDivider(title: string): string {
  const cols = process.stdout.columns || 82;
  const left = chalk.dim('─'.repeat(2));
  const rightWidth = Math.max(0, cols - 8 - title.length);
  const right = chalk.dim('─'.repeat(rightWidth));
  return `\n  ${left}  ${chalk.bold(title)}  ${right}`;
}
