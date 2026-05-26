import chalk from 'chalk';
import {
  bold,
  colorForLevel,
  cyan,
  dim,
  formatByteCount,
  formatCount,
  formatLocalDateTime,
  glyphForLevel,
  padLabel,
} from 'cli/commands/status/render/format-helpers.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';

const LABEL_WIDTH = 14;

export function renderBasic(inputs: RenderInputs): string {
  const lines: string[] = [];
  lines.push(renderHeader(inputs));
  lines.push('');
  lines.push(renderStatusLine(inputs));
  if (inputs.summary.hint !== null) {
    lines.push(`  ${dim(inputs.summary.hint)}`);
  }
  lines.push('');
  if (inputs.snapshot !== null) {
    lines.push(...renderTotals(inputs));
    lines.push('');
  }
  lines.push(dim('  Press q or Esc to quit · -v for verbose'));
  return lines.join('\n');
}

function renderHeader(inputs: RenderInputs): string {
  const version = inputs.version !== null ? ` ${dim(`v${inputs.version}`)}` : '';
  const dev = inputs.isDevMode ? ` ${cyan('(dev mode)')}` : '';
  const ts = dim(formatLocalDateTime(inputs.nowLocal));
  return `  ${bold('proxai-gateway')}${version}${dev}    ${ts}`;
}

function renderStatusLine(inputs: RenderInputs): string {
  const colorize = colorForLevel(inputs.summary.level);
  const glyph = glyphForLevel(inputs.summary.level);
  return `  ${glyph} ${colorize(inputs.summary.headline)}`;
}

function renderTotals(inputs: RenderInputs): string[] {
  const s = inputs.snapshot;
  if (s === null) return [];
  const uploadedSessions = s.totalBatchesShipped;
  const uploadedBytes = s.totalBytesShipped;
  const pendingSessions = s.counts.pending;
  const pendingBytesValue = s.pendingBytes;
  return [
    `  ${padLabel('Uploaded:', LABEL_WIDTH)}${formatCount(uploadedSessions)} sessions  ${dim(`(${formatByteCount(uploadedBytes)})`)}`,
    `  ${padLabel('Pending:', LABEL_WIDTH)}${formatCount(pendingSessions)} sessions  ${dim(`(${formatByteCount(pendingBytesValue)})`)}`,
    ...(s.counts.failed > 0
      ? [
          `  ${padLabel('Failed:', LABEL_WIDTH)}${chalk.red(formatCount(s.counts.failed))} sessions  ${dim(`(${formatByteCount(s.failedBytes)})`)}`,
        ]
      : []),
  ];
}
