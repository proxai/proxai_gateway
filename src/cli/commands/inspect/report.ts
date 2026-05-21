import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { formatBytes, formatTimeWithRelative } from 'core/utils';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';

import { formatRatio } from 'cli/commands/inspect/layout.ts';
import type {
  InspectSummary,
  SourceResult,
  SourceWarning,
} from 'cli/commands/inspect/inspect.types.ts';

export interface MarkdownReportInput {
  results: readonly SourceResult[];
  summary: InspectSummary;
  warnings: readonly SourceWarning[];
  durationMs: number;
  now: Date;
}

export interface WriteReportDeps {
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
}

export function resolveReportDir(): string {
  return process.platform === 'win32'
    ? join(tmpdir(), 'proxai-gateway', 'reports')
    : '/tmp/proxai-gateway/reports';
}

export function resolveReportPath(now: Date): string {
  return join(resolveReportDir(), `inspect_${now.toISOString().replace(/:/g, '-')}.md`);
}

export function buildMarkdownReport(input: MarkdownReportInput): string {
  const { results, summary, warnings, durationMs, now } = input;

  const diskRows = results
    .map((r) => {
      const oldest = r.oldestDate !== null ? formatTimeWithRelative(r.oldestDate) : 'None';
      return `| ${formatSourceLabel(r.sourceName)} | ${r.filesProcessed.toLocaleString()} | ${r.promptCount.toLocaleString()} | ${r.recordCount.toLocaleString()} | ${formatBytes(r.totalBytes)} | ${oldest} |`;
    })
    .join('\n');

  const uploadRows = results
    .map((r) => {
      const ratio = formatRatio(r.telemetryRawBytes, r.telemetryCompressedBytes);
      return `| ${formatSourceLabel(r.sourceName)} | ${r.promptCount.toLocaleString()} | ${r.telemetryRecordCount.toLocaleString()} | ${formatBytes(r.telemetryRawBytes)} | ${formatBytes(r.telemetryCompressedBytes)} | ${ratio}x |`;
    })
    .join('\n');

  const oldestText =
    summary.oldestDateIso !== null
      ? `${formatTimeWithRelative(summary.oldestDateIso)} (from ${formatSourceLabel(summary.oldestSource)})`
      : 'None found';
  const newestText =
    summary.newestDateIso !== null
      ? `${formatTimeWithRelative(summary.newestDateIso)} (from ${formatSourceLabel(summary.newestSource)})`
      : 'None found';
  const diskOldest =
    summary.oldestDateIso !== null ? formatTimeWithRelative(summary.oldestDateIso) : 'None';
  const totalRatio = formatRatio(summary.totalRawBytes, summary.totalCompressedBytes);
  const warningsSection =
    warnings.length > 0
      ? `\n## ⚠ Warnings\n\n${warnings
          .map((w) => `* **${formatSourceLabel(w.source)}:** ${w.message}`)
          .join('\n')}\n`
      : '';

  return `# ProxAI Telemetry Inspection Report

* **Generated At:** ${now.toLocaleString()} (${now.toISOString()})
* **Scan Duration:** ${durationMs.toFixed(2)} ms
* **Total Scanned Files:** ${summary.totalFiles}
* **Total Prompts:** ${summary.totalPrompts}
* **Total Captured Events:** ${summary.totalTelemetryRecords}
* **Total Disk Footprint:** ${formatBytes(summary.totalBytes)}

## 💾 Telemetry Sources on Disk (Historical Raw Data)

| Source | Files | Prompts | Log Events | Data Size | Oldest Record Date |
| :--- | :---: | :---: | :---: | :---: | :--- |
${diskRows}
| **TOTAL** | **${summary.totalFiles.toLocaleString()}** | **${summary.totalPrompts.toLocaleString()}** | **${summary.totalRecords.toLocaleString()}** | **${formatBytes(summary.totalBytes)}** | **${diskOldest}** |

## 🚀 Estimated Upload Metrics (If Fully Uploaded)

| Source | Prompts | Captured Events | Uncompressed Payload Size | Est. Upload Size (Compressed) | Compression Ratio |
| :--- | :---: | :---: | :---: | :---: | :---: |
${uploadRows}
| **TOTAL** | **${summary.totalPrompts.toLocaleString()}** | **${summary.totalTelemetryRecords.toLocaleString()}** | **${formatBytes(summary.totalRawBytes)}** | **${formatBytes(summary.totalCompressedBytes)}** | **${totalRatio}x** |

## 💡 Key Highlights

* **Oldest Telemetry Record:** ${oldestText}
* **Newest Telemetry Record:** ${newestText}
* **Scan Duration:** ${durationMs.toFixed(2)} ms
* **Dry-Run Mode:** No data was committed or modified during this inspection.
${warningsSection}`;
}

export async function writeMarkdownReport(
  reportPath: string,
  content: string,
  deps: WriteReportDeps = { mkdir, writeFile },
): Promise<void> {
  await deps.mkdir(dirname(reportPath), { recursive: true });
  await deps.writeFile(reportPath, content, 'utf-8');
}
