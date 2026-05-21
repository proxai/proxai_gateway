import chalk from 'chalk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { formatBytes, formatTimeWithRelative, formatRelative } from 'core/utils';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';
import { handleInspect } from 'services/polling/poll-worker.ts';

import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';

export interface InspectCommandDeps {
  output: OutputSink;
  configExists: () => Promise<boolean>;
  gatewayVersion: string;
}

export interface InspectCommandOptions {
  baseDirs?: {
    claudeCode?: string;
    cursor?: string;
    geminiCli?: string;
    codex?: string;
  };
}

interface SourceResult {
  sourceName: string;
  filesProcessed: number;
  recordCount: number;
  totalBytes: number;
  telemetryRawBytes: number;
  telemetryCompressedBytes: number;
  telemetryRecordCount: number;
  oldestDate: string | null;
  newestDate: string | null;
}

let spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let frameIndex = 0;
let currentText = '';
let intervalId: any = null;

function startSpinner(initialText: string): void {
  currentText = initialText;
  if (process?.stdout?.isTTY) {
    process.stdout.write('\x1B[?25l');
    intervalId = setInterval(() => {
      const frame = spinnerFrames[frameIndex];
      frameIndex = (frameIndex + 1) % spinnerFrames.length;
      process.stdout.write(`\r${chalk.cyan(frame)} ${currentText}`);
    }, 80);
  }
}

function updateSpinner(newText: string): void {
  currentText = newText;
  if (process?.stdout?.isTTY) {
    process.stdout.write('\r\x1B[K');
    const frame = spinnerFrames[frameIndex];
    process.stdout.write(`${chalk.cyan(frame)} ${currentText}`);
  }
}

function stopSpinner(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (process?.stdout?.isTTY) {
    process.stdout.write('\r\x1B[K');
    process.stdout.write('\x1B[?25h');
  }
}

async function scanSingleSource(
  sourceName: string,
  deps: InspectCommandDeps,
  options: InspectCommandOptions,
): Promise<SourceResult> {
  let baseDir: string | undefined;
  if (options.baseDirs) {
    if (sourceName === 'claude-code') baseDir = options.baseDirs.claudeCode;
    else if (sourceName === 'cursor') baseDir = options.baseDirs.cursor;
    else if (sourceName === 'gemini-cli') baseDir = options.baseDirs.geminiCli;
    else if (sourceName === 'codex') baseDir = options.baseDirs.codex;
  }

  const isCompiled = import.meta.url.includes('$bunfs') || import.meta.url.includes('bun:wrap');
  if (isCompiled) {
    try {
      const optionsObj: WorkerInput['options'] = {
        gatewayVersion: deps.gatewayVersion,
        maxDecompressedBytes: 10 * 1024 * 1024,
        captureSubAgents: true,
      };
      if (baseDir !== undefined) {
        optionsObj.baseDir = baseDir;
      }
      const res = await handleInspect(sourceName, optionsObj);
      return {
        sourceName,
        filesProcessed: res.filesProcessed,
        recordCount: res.recordCount,
        totalBytes: res.totalBytes,
        telemetryRawBytes: res.telemetryRawBytes,
        telemetryCompressedBytes: res.telemetryCompressedBytes,
        telemetryRecordCount: res.telemetryRecordCount,
        oldestDate: res.oldestDate,
        newestDate: res.newestDate,
      };
    } catch {
      return {
        sourceName,
        filesProcessed: 0,
        recordCount: 0,
        totalBytes: 0,
        telemetryRawBytes: 0,
        telemetryCompressedBytes: 0,
        telemetryRecordCount: 0,
        oldestDate: null,
        newestDate: null,
      };
    }
  }

  return new Promise<SourceResult>((resolve) => {
    try {
      const workerUrl = new URL('../../services/polling/poll-worker.ts', import.meta.url).href;
      const worker = new Worker(workerUrl, { type: 'module' });

      worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
        const res = event.data;
        worker.terminate();
        if (res.success && res.inspectResult) {
          resolve({
            sourceName,
            filesProcessed: res.inspectResult.filesProcessed,
            recordCount: res.inspectResult.recordCount,
            totalBytes: res.inspectResult.totalBytes,
            telemetryRawBytes: res.inspectResult.telemetryRawBytes,
            telemetryCompressedBytes: res.inspectResult.telemetryCompressedBytes,
            telemetryRecordCount: res.inspectResult.telemetryRecordCount,
            oldestDate: res.inspectResult.oldestDate,
            newestDate: res.inspectResult.newestDate,
          });
        } else {
          resolve({
            sourceName,
            filesProcessed: 0,
            recordCount: 0,
            totalBytes: 0,
            telemetryRawBytes: 0,
            telemetryCompressedBytes: 0,
            telemetryRecordCount: 0,
            oldestDate: null,
            newestDate: null,
          });
        }
      };

      worker.onerror = () => {
        worker.terminate();
        resolve({
          sourceName,
          filesProcessed: 0,
          recordCount: 0,
          totalBytes: 0,
          telemetryRawBytes: 0,
          telemetryCompressedBytes: 0,
          telemetryRecordCount: 0,
          oldestDate: null,
          newestDate: null,
        });
      };

      const optionsObj: WorkerInput['options'] = {
        gatewayVersion: deps.gatewayVersion,
        maxDecompressedBytes: 10 * 1024 * 1024,
        captureSubAgents: true,
      };
      if (baseDir !== undefined) {
        optionsObj.baseDir = baseDir;
      }

      worker.postMessage({
        task: 'inspect',
        sourceName,
        options: optionsObj,
      } as WorkerInput);
    } catch {
      resolve({
        sourceName,
        filesProcessed: 0,
        recordCount: 0,
        totalBytes: 0,
        telemetryRawBytes: 0,
        telemetryCompressedBytes: 0,
        telemetryRecordCount: 0,
        oldestDate: null,
        newestDate: null,
      });
    }
  });
}

function formatDiskRow(
  source: string,
  files: string,
  records: string,
  size: string,
  oldest: string,
  options: { isHeader?: boolean; isTotal?: boolean } = {},
): string {
  const c1 = source.padEnd(16);
  const c2 = files.padStart(13);
  const c3 = records.padStart(13);
  const c4 = size.padStart(11);
  const c5 = oldest.padEnd(11);

  if (options.isHeader || options.isTotal) {
    return `│ ${chalk.bold(c1)} │ ${chalk.bold(c2)} │ ${chalk.bold(c3)} │ ${chalk.bold(c4)} │ ${chalk.bold(c5)} │`;
  }
  return `│ ${chalk.cyan(c1)} │ ${c2} │ ${c3} │ ${c4} │ ${chalk.dim(c5)} │`;
}

function formatUploadRow(
  source: string,
  records: string,
  uncompressed: string,
  uploadSize: string,
  options: { isHeader?: boolean; isTotal?: boolean } = {},
): string {
  const c1 = source.padEnd(16);
  const c2 = records.padStart(17);
  const c3 = uncompressed.padStart(13);
  const c4 = uploadSize.padEnd(21);

  if (options.isHeader || options.isTotal) {
    return `│ ${chalk.bold(c1)} │ ${chalk.bold(c2)} │ ${chalk.bold(c3)} │ ${chalk.bold(c4)} │`;
  }
  return `│ ${chalk.cyan(c1)} │ ${c2} │ ${c3} │ ${c4} │`;
}

export async function runInspect(
  deps: InspectCommandDeps,
  options: InspectCommandOptions = {},
): Promise<CommandResult> {
  const { output } = deps;

  output.info(chalk.bold('🔍 ProxAI Telemetry Dry-Run Inspection'));
  output.info('');

  const sources = ['claude-code', 'cursor', 'codex', 'gemini-cli'];
  const startMs = performance.now();

  try {
    startSpinner('Initializing inspection...');
    const results: SourceResult[] = [];
    for (const sourceName of sources) {
      updateSpinner(`Scanning ${chalk.yellow(formatSourceLabel(sourceName))}...`);
      const res = await scanSingleSource(sourceName, deps, options);
      results.push(res);
    }
    stopSpinner();

    const durationMs = performance.now() - startMs;

    let totalFiles = 0;
    let totalRecords = 0;
    let totalTelemetryRecords = 0;
    let totalBytes = 0;
    let totalRawBytes = 0;
    let totalCompressedBytes = 0;
    let overallOldestMs = Infinity;
    let overallOldestSource = '';
    let overallNewestMs = -Infinity;
    let overallNewestSource = '';

    for (const r of results) {
      totalFiles += r.filesProcessed;
      totalRecords += r.recordCount;
      totalTelemetryRecords += r.telemetryRecordCount;
      totalBytes += r.totalBytes;
      totalRawBytes += r.telemetryRawBytes;
      totalCompressedBytes += r.telemetryCompressedBytes;
      if (r.oldestDate) {
        const ms = Date.parse(r.oldestDate);
        if (Number.isFinite(ms) && ms < overallOldestMs) {
          overallOldestMs = ms;
          overallOldestSource = r.sourceName;
        }
      }
      if (r.newestDate) {
        const ms = Date.parse(r.newestDate);
        if (Number.isFinite(ms) && ms > overallNewestMs) {
          overallNewestMs = ms;
          overallNewestSource = r.sourceName;
        }
      }
    }

    const oldestDateIso =
      overallOldestMs === Infinity ? null : new Date(overallOldestMs).toISOString();
    const newestDateIso =
      overallNewestMs === -Infinity ? null : new Date(overallNewestMs).toISOString();

    output.info(chalk.bold('┌' + '─'.repeat(78) + '┐'));
    const titleDisk = ' 💾 TELEMETRY SOURCES ON DISK (HISTORICAL RAW DATA)';
    output.info(`│ ${chalk.bold.blue(titleDisk.padEnd(76))} │`);
    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(13) +
        '┼' +
        '─'.repeat(13) +
        '┤',
    );

    output.info(
      formatDiskRow('Source', 'Scanned Files', 'Total Records', 'Data Size', 'Oldest', {
        isHeader: true,
      }),
    );
    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(13) +
        '┼' +
        '─'.repeat(13) +
        '┤',
    );

    for (const r of results) {
      const label = formatSourceLabel(r.sourceName);
      const files = r.filesProcessed.toLocaleString();
      const records = r.recordCount.toLocaleString();
      const size = formatBytes(r.totalBytes);
      const oldest = r.oldestDate ? formatRelative(r.oldestDate) : 'None';
      output.info(formatDiskRow(label, files, records, size, oldest));
    }

    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(13) +
        '┼' +
        '─'.repeat(13) +
        '┤',
    );

    const totalOldestStr = oldestDateIso ? formatRelative(oldestDateIso) : 'None';
    output.info(
      formatDiskRow(
        'TOTAL',
        totalFiles.toLocaleString(),
        totalRecords.toLocaleString(),
        formatBytes(totalBytes),
        totalOldestStr,
        { isTotal: true },
      ),
    );
    output.info(
      '└' +
        '─'.repeat(18) +
        '┴' +
        '─'.repeat(15) +
        '┴' +
        '─'.repeat(15) +
        '┴' +
        '─'.repeat(13) +
        '┴' +
        '─'.repeat(13) +
        '┘',
    );

    output.info('');

    output.info(chalk.bold('┌' + '─'.repeat(78) + '┐'));
    const titleUpload = ' 🚀 ESTIMATED UPLOAD METRICS (IF FULLY UPLOADED)';
    output.info(`│ ${chalk.bold.green(titleUpload.padEnd(76))} │`);
    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(19) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(23) +
        '┤',
    );

    output.info(
      formatUploadRow('Source', 'Telemetry Records', 'Uncompressed', 'Est. Upload Size', {
        isHeader: true,
      }),
    );
    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(19) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(23) +
        '┤',
    );

    for (const r of results) {
      const label = formatSourceLabel(r.sourceName);
      const records = r.telemetryRecordCount.toLocaleString();
      const uncompressed = formatBytes(r.telemetryRawBytes);
      const ratio =
        r.telemetryRawBytes > 0
          ? (r.telemetryRawBytes / r.telemetryCompressedBytes).toFixed(1)
          : '6.0';
      const uploadStr = `${formatBytes(r.telemetryCompressedBytes)} (${ratio}x)`;
      output.info(formatUploadRow(label, records, uncompressed, uploadStr));
    }

    output.info(
      '├' +
        '─'.repeat(18) +
        '┼' +
        '─'.repeat(19) +
        '┼' +
        '─'.repeat(15) +
        '┼' +
        '─'.repeat(23) +
        '┤',
    );

    const overallRatio =
      totalRawBytes > 0 ? (totalRawBytes / totalCompressedBytes).toFixed(1) : '6.0';
    const totalUploadStr = `${formatBytes(totalCompressedBytes)} (${overallRatio}x)`;
    output.info(
      formatUploadRow(
        'TOTAL',
        totalTelemetryRecords.toLocaleString(),
        formatBytes(totalRawBytes),
        totalUploadStr,
        { isTotal: true },
      ),
    );
    output.info(
      '└' +
        '─'.repeat(18) +
        '┴' +
        '─'.repeat(19) +
        '┴' +
        '─'.repeat(15) +
        '┴' +
        '─'.repeat(23) +
        '┘',
    );

    output.info('');

    output.info(chalk.bold('💡 Highlights'));

    if (oldestDateIso) {
      output.info(
        `  • Oldest telemetry record: ${chalk.green(formatTimeWithRelative(oldestDateIso))} (Source: ${chalk.cyan(formatSourceLabel(overallOldestSource))})`,
      );
    } else {
      output.info(`  • No telemetry records found.`);
    }

    if (newestDateIso) {
      output.info(
        `  • Newest telemetry record: ${chalk.green(formatTimeWithRelative(newestDateIso))} (Source: ${chalk.cyan(formatSourceLabel(overallNewestSource))})`,
      );
    }

    output.info(`  • Scan duration: ${chalk.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info('');

    const now = new Date();
    const timestampTz = now.toISOString().replace(/:/g, '-');
    const reportDir =
      process.platform === 'win32'
        ? join(tmpdir(), 'proxai-gateway', 'reports')
        : '/tmp/proxai-gateway/reports';
    const reportFileName = `inspect_${timestampTz}.md`;
    const reportPath = join(reportDir, reportFileName);

    const markdownContent = `# ProxAI Telemetry Inspection Report

* **Generated At:** ${now.toLocaleString()} (${now.toISOString()})
* **Scan Duration:** ${durationMs.toFixed(2)} ms
* **Total Scanned Files:** ${totalFiles}
* **Total Telemetry Records:** ${totalTelemetryRecords}
* **Total Disk Footprint:** ${formatBytes(totalBytes)}

## 💾 Telemetry Sources on Disk (Historical Raw Data)

| Source | Scanned Files | Total Records | Data Size | Oldest Record Date |
| :--- | :---: | :---: | :---: | :--- |
${results
  .map((r) => {
    const name = formatSourceLabel(r.sourceName);
    const files = r.filesProcessed.toLocaleString();
    const records = r.recordCount.toLocaleString();
    const size = formatBytes(r.totalBytes);
    const oldest = r.oldestDate ? formatTimeWithRelative(r.oldestDate) : 'None';
    return `| ${name} | ${files} | ${records} | ${size} | ${oldest} |`;
  })
  .join('\n')}
| **TOTAL** | **${totalFiles.toLocaleString()}** | **${totalRecords.toLocaleString()}** | **${formatBytes(totalBytes)}** | **${oldestDateIso ? formatTimeWithRelative(oldestDateIso) : 'None'}** |

## 🚀 Estimated Upload Metrics (If Fully Uploaded)

| Source | Telemetry Records | Uncompressed Payload Size | Est. Upload Size (Compressed) | Compression Ratio |
| :--- | :---: | :---: | :---: | :---: |
${results
  .map((r) => {
    const name = formatSourceLabel(r.sourceName);
    const records = r.telemetryRecordCount.toLocaleString();
    const uncompressed = formatBytes(r.telemetryRawBytes);
    const compressed = formatBytes(r.telemetryCompressedBytes);
    const ratio =
      r.telemetryRawBytes > 0
        ? (r.telemetryRawBytes / r.telemetryCompressedBytes).toFixed(1) + 'x'
        : '6.0x';
    return `| ${name} | ${records} | ${uncompressed} | ${compressed} | ${ratio} |`;
  })
  .join('\n')}
| **TOTAL** | **${totalTelemetryRecords.toLocaleString()}** | **${formatBytes(totalRawBytes)}** | **${formatBytes(totalCompressedBytes)}** | **${totalRawBytes > 0 ? (totalRawBytes / totalCompressedBytes).toFixed(1) + 'x' : '6.0x'}** |

## 💡 Key Highlights

* **Oldest Telemetry Record:** ${oldestDateIso ? `${formatTimeWithRelative(oldestDateIso)} (from ${formatSourceLabel(overallOldestSource)})` : 'None found'}
* **Newest Telemetry Record:** ${newestDateIso ? `${formatTimeWithRelative(newestDateIso)} (from ${formatSourceLabel(overallNewestSource)})` : 'None found'}
* **Scan Duration:** ${durationMs.toFixed(2)} ms
* **Dry-Run Mode:** No data was committed or modified during this inspection.
`;

    try {
      await mkdir(reportDir, { recursive: true });
      await writeFile(reportPath, markdownContent, 'utf-8');
      output.success(`Beautiful dry-run markdown report saved to: ${chalk.cyan(reportPath)}`);
    } catch (err) {
      output.error(
        `Failed to save markdown report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    output.info(chalk.dim('─'.repeat(80)));
    output.info(`✨ Inspection completed in ${chalk.bold.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info(chalk.dim('─'.repeat(80)));
    output.info('');

    return { exitCode: EXIT_CODE.ok };
  } catch (err) {
    stopSpinner();
    const durationMs = performance.now() - startMs;
    output.error(`Unexpected inspect error: ${err instanceof Error ? err.message : String(err)}`);
    output.info(chalk.dim('─'.repeat(80)));
    output.info(`✨ Inspection failed after ${chalk.bold.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info(chalk.dim('─'.repeat(80)));
    output.info('');
    return { exitCode: EXIT_CODE.error };
  }
}
