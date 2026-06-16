import chalk from 'chalk';

import { formatBytes, formatDuration, formatTimeWithRelative } from 'core/utils';

import { sectionHeader } from 'cli/commands/status/decorators.ts';
import { BYTES_COL, COUNT_COL, keyCol, subRow } from 'cli/commands/status/layout.ts';

export interface UploadSourceTotals {
  batches: number;
  bytes: number;
}

export type UploadBySource = Record<string, UploadSourceTotals>;

export interface UploadSectionInput {
  totalBatchesShipped: number;
  totalBytesShipped: number;
  drainCyclesTotal: number;
  drainCyclesTotalDurationMs: number;
  shippedBySource: UploadBySource | null;
  lastCycleCompletedAt: string | null;
  lastCycleAttempted: number | null;
  lastCycleAccepted: number | null;
  lastCycleRetriable: number | null;
  lastCycleFatal: number | null;
  lastSuccessAt: string | null;
  lastSuccessBatches: number | null;
  lastSuccessBytes: number | null;
  now: Date;
}

export function renderUploadSection(input: UploadSectionInput): string[] {
  const lines: string[] = [sectionHeader('Upload')];

  if (input.drainCyclesTotal > 0 || input.totalBatchesShipped > 0) {
    const c = input.totalBatchesShipped.toString().padStart(COUNT_COL);
    const b = formatBytes(input.totalBytesShipped).padStart(BYTES_COL);
    const cy = input.drainCyclesTotal.toString();
    lines.push(
      `  ${keyCol('12-Month')}${c} ${chalk.dim('batches shipped')}   ·   ${b} ${chalk.dim('compressed')}   ·   ${cy} ${chalk.dim('drain cycles')}`,
    );

    if (input.shippedBySource !== null) {
      for (const [name, totals] of Object.entries(input.shippedBySource)) {
        if (totals.batches > 0) {
          lines.push(subRow(name, totals.batches, totals.bytes));
        }
      }
    }
  } else {
    lines.push(`  ${keyCol('12-Month')}${chalk.dim('— no drain cycles completed yet')}`);
  }

  if (input.drainCyclesTotal > 0) {
    const avgBatches = input.totalBatchesShipped / input.drainCyclesTotal;
    const avgBytes = input.totalBytesShipped / input.drainCyclesTotal;
    const avgMs = input.drainCyclesTotalDurationMs / input.drainCyclesTotal;
    const ab = avgBatches.toFixed(1).padStart(COUNT_COL);
    const aby = formatBytes(avgBytes).padStart(BYTES_COL);
    const ams = formatDuration(avgMs);
    lines.push(
      `  ${keyCol('Avg / drain')}${ab} ${chalk.dim('batches')}        ·   ${aby} ${chalk.dim('compressed')}   ·   ${ams}`,
    );
  } else {
    lines.push(`  ${keyCol('Avg / drain')}${chalk.dim('— no drain cycles yet')}`);
  }

  if (input.lastCycleCompletedAt !== null) {
    const attempted = input.lastCycleAttempted ?? 0;
    const accepted = input.lastCycleAccepted ?? 0;
    const retriable = input.lastCycleRetriable ?? 0;
    const fatal = input.lastCycleFatal ?? 0;
    const retriableStr =
      retriable > 0
        ? chalk.yellow(`${retriable.toString()} retriable`)
        : `${retriable.toString()} retriable`;
    const fatalStr =
      fatal > 0 ? chalk.red(`${fatal.toString()} fatal`) : `${fatal.toString()} fatal`;
    lines.push(
      `  ${keyCol('Last drain')}${formatTimeWithRelative(input.lastCycleCompletedAt, { now: input.now })}   ${chalk.dim('·')}  ${attempted.toString()} attempted   ${accepted.toString()} accepted   ${retriableStr}   ${fatalStr}`,
    );
  } else {
    lines.push(`  ${keyCol('Last drain')}${chalk.dim('— no drain completed yet')}`);
  }

  if (input.lastSuccessAt !== null) {
    const batches = input.lastSuccessBatches ?? 0;
    const bytes = input.lastSuccessBytes ?? 0;
    lines.push(
      `  ${keyCol('Last success')}${formatTimeWithRelative(input.lastSuccessAt, { now: input.now })}   ${chalk.dim('·')}  ${batches.toString()} batches      ${formatBytes(bytes)} shipped`,
    );
  } else {
    lines.push(`  ${keyCol('Last success')}${chalk.dim('— no successful upload yet')}`);
  }

  return lines;
}
