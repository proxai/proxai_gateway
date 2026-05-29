import chalk from 'chalk';

import { formatBytes, formatRelative, formatTimeWithRelative } from 'core/utils';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';

import {
  DISK_TABLE_SEGMENTS,
  DISK_TITLE,
  FALLBACK_COMPRESSION_RATIO,
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

export function getTerminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols > 0) {
    return Math.min(80, cols);
  }
  return 80;
}

export function scaleSegments(
  originalSegments: readonly number[],
  targetTotalWidth: number,
): number[] {
  const numSegments = originalSegments.length;

  const targetSum = targetTotalWidth - numSegments - 1;
  const originalSum = originalSegments.reduce((sum, val) => sum + val, 0);

  if (targetSum <= 0) {
    return originalSegments.map(() => 4);
  }

  const minWidth = 4;

  const segments = originalSegments.map((orig) => {
    const val = Math.floor(orig * (targetSum / originalSum));
    return Math.max(minWidth, val);
  });

  let currentSum = segments.reduce((sum, val) => sum + val, 0);

  if (currentSum < targetSum) {
    let remainder = targetSum - currentSum;
    const fractionalLosses = originalSegments.map((orig, idx) => ({
      idx,
      loss: orig * (targetSum / originalSum) - Math.floor(orig * (targetSum / originalSum)),
    }));
    fractionalLosses.sort((a, b) => b.loss - a.loss);

    let i = 0;
    while (remainder > 0) {
      const item = fractionalLosses[i % numSegments];
      if (item !== undefined) {
        const targetIdx = item.idx;
        const currentVal = segments[targetIdx];
        if (currentVal !== undefined) {
          segments[targetIdx] = currentVal + 1;
        }
      }
      remainder--;
      i++;
    }
  } else if (currentSum > targetSum) {
    let excess = currentSum - targetSum;
    while (excess > 0) {
      let reducedAny = false;
      for (let idx = 0; idx < numSegments; idx++) {
        const currentVal = segments[idx];
        if (currentVal !== undefined && currentVal > minWidth) {
          segments[idx] = currentVal - 1;
          excess--;
          reducedAny = true;
          if (excess === 0) break;
        }
      }
      if (!reducedAny) {
        break;
      }
    }
  }

  return segments;
}

export function formatCell(text: string, width: number, align: 'left' | 'right'): string {
  if (text.length > width) {
    if (width >= 4) {
      return align === 'left' ? text.slice(0, width - 1) + '…' : '…' + text.slice(-(width - 1));
    } else {
      return text.slice(0, width);
    }
  }
  return align === 'left' ? text.padEnd(width) : text.padStart(width);
}

export function formatTitle(title: string, innerWidth: number): string {
  const targetLen = innerWidth - 2;
  if (title.length > targetLen) {
    if (targetLen >= 4) {
      return title.slice(0, targetLen - 1) + '…';
    }
    return title.slice(0, targetLen);
  }
  return title.padEnd(targetLen);
}

export function formatDiskRow(
  source: string,
  files: string,
  prompts: string,
  events: string,
  size: string,
  oldest: string,
  style: RowStyle = {},
  segments: readonly number[] = DISK_TABLE_SEGMENTS,
): string {
  const w1 = Math.max(0, (segments[0] ?? 0) - 2);
  const w2 = Math.max(0, (segments[1] ?? 0) - 2);
  const w3 = Math.max(0, (segments[2] ?? 0) - 2);
  const w4 = Math.max(0, (segments[3] ?? 0) - 2);
  const w5 = Math.max(0, (segments[4] ?? 0) - 2);
  const w6 = Math.max(0, (segments[5] ?? 0) - 2);

  const c1 = formatCell(source, w1, 'left');
  const c2 = formatCell(files, w2, 'right');
  const c3 = formatCell(prompts, w3, 'right');
  const c4 = formatCell(events, w4, 'right');
  const c5 = formatCell(size, w5, 'right');
  const c6 = formatCell(oldest, w6, 'left');

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
  segments: readonly number[] = UPLOAD_TABLE_SEGMENTS,
): string {
  const w1 = Math.max(0, (segments[0] ?? 0) - 2);
  const w2 = Math.max(0, (segments[1] ?? 0) - 2);
  const w3 = Math.max(0, (segments[2] ?? 0) - 2);
  const w4 = Math.max(0, (segments[3] ?? 0) - 2);
  const w5 = Math.max(0, (segments[4] ?? 0) - 2);

  const c1 = formatCell(source, w1, 'left');
  const c2 = formatCell(prompts, w2, 'right');
  const c3 = formatCell(events, w3, 'right');
  const c4 = formatCell(uncompressed, w4, 'right');
  const c5 = formatCell(uploadSize, w5, 'left');

  if (style.isHeader === true || style.isTotal === true) {
    return `│ ${chalk.bold(c1)} │ ${chalk.bold(c2)} │ ${chalk.bold(c3)} │ ${chalk.bold(c4)} │ ${chalk.bold(c5)} │`;
  }
  return `│ ${chalk.cyan(c1)} │ ${c2} │ ${c3} │ ${c4} │ ${c5} │`;
}

export function renderDiskTable(
  results: readonly SourceResult[],
  summary: InspectSummary,
  terminalWidth?: number,
): string[] {
  const width = terminalWidth !== undefined ? terminalWidth : getTerminalWidth();
  const segments = scaleSegments(DISK_TABLE_SEGMENTS, width);
  const innerWidth = width - 2;

  const lines: string[] = [];
  lines.push(chalk.bold('┌' + '─'.repeat(innerWidth) + '┐'));
  lines.push(`│ ${chalk.bold.blue(formatTitle(DISK_TITLE, innerWidth))} │`);
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  lines.push(
    formatDiskRow(
      'Source',
      'Files',
      'Prompts',
      'Log Events',
      'Data Size',
      'Oldest',
      {
        isHeader: true,
      },
      segments,
    ),
  );
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  for (const r of results) {
    lines.push(
      formatDiskRow(
        formatSourceLabel(r.sourceName),
        r.filesProcessed.toLocaleString(),
        r.promptCount.toLocaleString(),
        r.recordCount.toLocaleString(),
        formatBytes(r.totalBytes),
        r.oldestDate !== null ? formatRelative(r.oldestDate) : 'None',
        {},
        segments,
      ),
    );
  }
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  lines.push(
    formatDiskRow(
      'TOTAL',
      summary.totalFiles.toLocaleString(),
      summary.totalPrompts.toLocaleString(),
      summary.totalRecords.toLocaleString(),
      formatBytes(summary.totalBytes),
      summary.oldestDateIso !== null ? formatRelative(summary.oldestDateIso) : 'None',
      { isTotal: true },
      segments,
    ),
  );
  lines.push(tableDivider(segments, '└', '┴', '┘'));
  return lines;
}

export function renderUploadTable(
  results: readonly SourceResult[],
  summary: InspectSummary,
  terminalWidth?: number,
): string[] {
  const width = terminalWidth !== undefined ? terminalWidth : getTerminalWidth();
  const segments = scaleSegments(UPLOAD_TABLE_SEGMENTS, width);
  const innerWidth = width - 2;

  const lines: string[] = [];
  lines.push(chalk.bold('┌' + '─'.repeat(innerWidth) + '┐'));
  lines.push(`│ ${chalk.bold.green(formatTitle(UPLOAD_TITLE, innerWidth))} │`);
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  lines.push(
    formatUploadRow(
      'Source',
      'Prompts',
      'Captured Events',
      'Uncompressed',
      'Est. Upload',
      {
        isHeader: true,
      },
      segments,
    ),
  );
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  for (const r of results) {
    const ratio = formatRatio(r.telemetryRawBytes, r.telemetryCompressedBytes);
    lines.push(
      formatUploadRow(
        formatSourceLabel(r.sourceName),
        r.promptCount.toLocaleString(),
        r.telemetryRecordCount.toLocaleString(),
        formatBytes(r.telemetryRawBytes),
        `${formatBytes(r.telemetryCompressedBytes)} (${ratio}x)`,
        {},
        segments,
      ),
    );
  }
  lines.push(tableDivider(segments, '├', '┼', '┤'));
  const totalRatio = formatRatio(summary.totalRawBytes, summary.totalCompressedBytes);
  lines.push(
    formatUploadRow(
      'TOTAL',
      summary.totalPrompts.toLocaleString(),
      summary.totalTelemetryRecords.toLocaleString(),
      formatBytes(summary.totalRawBytes),
      `${formatBytes(summary.totalCompressedBytes)} (${totalRatio}x)`,
      { isTotal: true },
      segments,
    ),
  );
  lines.push(tableDivider(segments, '└', '┴', '┘'));
  return lines;
}

export function renderWarnings(warnings: readonly SourceWarning[]): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = [chalk.bold.yellow('Warnings')];
  for (const w of warnings) {
    lines.push(`  • ${chalk.cyan(formatSourceLabel(w.source))}: ${chalk.yellow(w.message)}`);
  }
  return lines;
}

export function renderHighlights(summary: InspectSummary, durationMs: number): string[] {
  const lines: string[] = [chalk.bold('Highlights')];
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
