import chalk from 'chalk';

import { formatBytes, formatPercent, formatTimeWithRelative } from 'core/utils';
import type { CountsBySource } from 'services/buffer';

import { sectionHeader } from 'cli/commands/status/decorators.ts';
import { COUNT_COL, keyCol, subRow, summaryHeadline } from 'cli/commands/status/layout.ts';

export interface BufferSectionInput {
  pendingCount: number;
  pendingBytes: number;
  failedCount: number;
  failedBytes: number;
  receiptsCount: number;
  quarantinedCount?: number;
  pressurePendingBytes: number;
  pressureSoftPauseBytes: number;
  lastPruneAt: string | null;
  bySource: CountsBySource | null;
  now: Date;
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
  const quarantinedCount = input.quarantinedCount ?? 0;
  if (quarantinedCount > 0) {
    lines.push(
      `  ${keyCol('Quarantined')}${quarantinedCount.toString().padStart(COUNT_COL)} ${chalk.dim('records')}                ${chalk.dim('oversized rows skipped on capture')}`,
    );
  }
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
