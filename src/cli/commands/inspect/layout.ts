import chalk from 'chalk';

import { formatBytes, formatRelative, formatTimeWithRelative } from 'core/utils';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';

import {
  DISK_TABLE_SEGMENTS,
  DISK_TITLE,
  FALLBACK_COMPRESSION_RATIO,
  TABLE_INNER_WIDTH,
  UPLOAD_TABLE_SEGMENTS,
  UPLOAD_TITLE,
} from 'cli/commands/inspect/inspect.constants.ts';
import type {
  InspectSummary,
  SourceResult,
  SourceWarning,
} from 'cli/commands/inspect/inspect.types.ts';

interface RowStyle {
  isHeader?: boolean;
  isTotal?: boolean;
}

export function formatRatio(rawBytes: number, compressedBytes: number): string {
  if (rawBytes > 0 && compressedBytes > 0) {
    return (rawBytes / compressedBytes).toFixed(1);
  }
  return FALLBACK_COMPRESSION_RATIO;
}

export function tableDivider(
  segments: readonly number[],
  left: string,
  mid: string,
  right: string,
): string {
  return left + segments.map((width) => '─'.repeat(width)).join(mid) + right;
}

export function formatDiskRow(
  source: string,
  files: string,
  prompts: string,
  events: string,
  size: string,
  oldest: string,
  style: RowStyle = {},
): string {
  const c1 = source.padEnd(14);
  const c2 = files.padStart(8);
  const c3 = prompts.padStart(9);
  const c4 = events.padStart(12);
  const c5 = size.padStart(10);
  const c6 = oldest.padEnd(8);
  if (style.isHeader === true || style.isTotal === true) {
    return `│ ${chalk.bold(c1)} │ ${chalk.bold(c2)} │ ${chalk.bold(c3)} │ ${chalk.bold(c4)} │ ${chalk.bold(c5)} │ ${chalk.bold(c6)} │`;
  }
  return `│ ${chalk.cyan(c1)} │ ${c2} │ ${c3} │ ${c4} │ ${c5} │ ${chalk.dim(c6)} │`;
}

export function formatUploadRow(
  source: string,
  prompts: string,
  events: string,
  uncompressed: string,
  uploadSize: string,
  style: RowStyle = {},
): string {
  const c1 = source.padEnd(12);
  const c2 = prompts.padStart(8);
  const c3 = events.padStart(15);
  const c4 = uncompressed.padStart(13);
  const c5 = uploadSize.padEnd(16);
  if (style.isHeader === true || style.isTotal === true) {
    return `│ ${chalk.bold(c1)} │ ${chalk.bold(c2)} │ ${chalk.bold(c3)} │ ${chalk.bold(c4)} │ ${chalk.bold(c5)} │`;
  }
  return `│ ${chalk.cyan(c1)} │ ${c2} │ ${c3} │ ${c4} │ ${c5} │`;
}

export function renderDiskTable(
  results: readonly SourceResult[],
  summary: InspectSummary,
): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold('┌' + '─'.repeat(TABLE_INNER_WIDTH) + '┐'));
  lines.push(`│ ${chalk.bold.blue(DISK_TITLE.padEnd(76))} │`);
  lines.push(tableDivider(DISK_TABLE_SEGMENTS, '├', '┼', '┤'));
  lines.push(
    formatDiskRow('Source', 'Files', 'Prompts', 'Log Events', 'Data Size', 'Oldest', {
      isHeader: true,
    }),
  );
  lines.push(tableDivider(DISK_TABLE_SEGMENTS, '├', '┼', '┤'));
  for (const r of results) {
    lines.push(
      formatDiskRow(
        formatSourceLabel(r.sourceName),
        r.filesProcessed.toLocaleString(),
        r.promptCount.toLocaleString(),
        r.recordCount.toLocaleString(),
        formatBytes(r.totalBytes),
        r.oldestDate !== null ? formatRelative(r.oldestDate) : 'None',
      ),
    );
  }
  lines.push(tableDivider(DISK_TABLE_SEGMENTS, '├', '┼', '┤'));
  lines.push(
    formatDiskRow(
      'TOTAL',
      summary.totalFiles.toLocaleString(),
      summary.totalPrompts.toLocaleString(),
      summary.totalRecords.toLocaleString(),
      formatBytes(summary.totalBytes),
      summary.oldestDateIso !== null ? formatRelative(summary.oldestDateIso) : 'None',
      { isTotal: true },
    ),
  );
  lines.push(tableDivider(DISK_TABLE_SEGMENTS, '└', '┴', '┘'));
  return lines;
}

export function renderUploadTable(
  results: readonly SourceResult[],
  summary: InspectSummary,
): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold('┌' + '─'.repeat(TABLE_INNER_WIDTH) + '┐'));
  lines.push(`│ ${chalk.bold.green(UPLOAD_TITLE.padEnd(76))} │`);
  lines.push(tableDivider(UPLOAD_TABLE_SEGMENTS, '├', '┼', '┤'));
  lines.push(
    formatUploadRow('Source', 'Prompts', 'Captured Events', 'Uncompressed', 'Est. Upload', {
      isHeader: true,
    }),
  );
  lines.push(tableDivider(UPLOAD_TABLE_SEGMENTS, '├', '┼', '┤'));
  for (const r of results) {
    const ratio = formatRatio(r.telemetryRawBytes, r.telemetryCompressedBytes);
    lines.push(
      formatUploadRow(
        formatSourceLabel(r.sourceName),
        r.promptCount.toLocaleString(),
        r.telemetryRecordCount.toLocaleString(),
        formatBytes(r.telemetryRawBytes),
        `${formatBytes(r.telemetryCompressedBytes)} (${ratio}x)`,
      ),
    );
  }
  lines.push(tableDivider(UPLOAD_TABLE_SEGMENTS, '├', '┼', '┤'));
  const totalRatio = formatRatio(summary.totalRawBytes, summary.totalCompressedBytes);
  lines.push(
    formatUploadRow(
      'TOTAL',
      summary.totalPrompts.toLocaleString(),
      summary.totalTelemetryRecords.toLocaleString(),
      formatBytes(summary.totalRawBytes),
      `${formatBytes(summary.totalCompressedBytes)} (${totalRatio}x)`,
      { isTotal: true },
    ),
  );
  lines.push(tableDivider(UPLOAD_TABLE_SEGMENTS, '└', '┴', '┘'));
  return lines;
}

export function renderWarnings(warnings: readonly SourceWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = [chalk.bold.yellow('⚠ Warnings')];
  for (const w of warnings) {
    lines.push(`  • ${chalk.cyan(formatSourceLabel(w.source))}: ${chalk.yellow(w.message)}`);
  }
  return lines;
}

export function renderHighlights(summary: InspectSummary, durationMs: number): string[] {
  const lines: string[] = [chalk.bold('💡 Highlights')];
  lines.push(
    `  • Prompts you sent (estimated): ${chalk.green(summary.totalPrompts.toLocaleString())}`,
  );
  if (summary.oldestDateIso !== null) {
    lines.push(
      `  • Oldest telemetry record: ${chalk.green(formatTimeWithRelative(summary.oldestDateIso))} (Source: ${chalk.cyan(formatSourceLabel(summary.oldestSource))})`,
    );
  } else {
    lines.push('  • No telemetry records found.');
  }
  if (summary.newestDateIso !== null) {
    lines.push(
      `  • Newest telemetry record: ${chalk.green(formatTimeWithRelative(summary.newestDateIso))} (Source: ${chalk.cyan(formatSourceLabel(summary.newestSource))})`,
    );
  }
  lines.push(`  • Scan duration: ${chalk.yellow(durationMs.toFixed(2) + ' ms')}`);
  return lines;
}
