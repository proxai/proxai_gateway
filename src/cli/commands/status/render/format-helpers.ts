import chalk from 'chalk';
import { formatBytes } from 'core/utils';
import type { UnifiedStatusLevel } from 'cli/commands/status/unified-summary.types.ts';

const HEADLINE_GLYPH: Record<UnifiedStatusLevel, string> = {
  ok: '',
  warning: '',
  error: '',
  inactive: '',
};

export function colorForLevel(level: UnifiedStatusLevel): (text: string) => string {
  if (level === 'ok') return chalk.green;
  if (level === 'warning') return chalk.yellow;
  if (level === 'error') return chalk.red;
  return chalk.dim;
}

export function glyphForLevel(level: UnifiedStatusLevel): string {
  return colorForLevel(level)(HEADLINE_GLYPH[level]);
}

export function formatLocalDateTime(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const h = d.getHours().toString().padStart(2, '0');
  const mi = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${mi}:${s}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatByteCount(bytes: number): string {
  return formatBytes(bytes);
}

export function padLabel(label: string, width: number): string {
  if (label.length >= width) return label;
  return label + ' '.repeat(width - label.length);
}

export function dim(text: string): string {
  return chalk.dim(text);
}

export function bold(text: string): string {
  return chalk.bold(text);
}

export function cyan(text: string): string {
  return chalk.cyan(text);
}
