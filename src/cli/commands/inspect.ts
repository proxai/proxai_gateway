/* eslint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin */
import chalk from 'chalk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { formatBytes, formatTimeWithRelative } from 'core/utils';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';

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
  oldestDate: string | null;
}

export async function runInspect(
  deps: InspectCommandDeps,
  options: InspectCommandOptions = {},
): Promise<CommandResult> {
  const { output } = deps;

  output.info(chalk.bold('🔍 ProxAI Telemetry Dry-Run Inspection'));
  output.info(
    chalk.dim(
      'Scanning local telemetry sources... (This is a dry-run and will not write to buffer)',
    ),
  );
  output.info('');

  const sources = ['claude-code', 'cursor', 'codex', 'gemini-cli'];
  const startMs = performance.now();

  try {
    const scanPromises = sources.map((sourceName) => {
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
                oldestDate: res.inspectResult.oldestDate,
              });
            } else {
              resolve({
                sourceName,
                filesProcessed: 0,
                recordCount: 0,
                totalBytes: 0,
                oldestDate: null,
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
              oldestDate: null,
            });
          };

          let baseDir: string | undefined;
          if (options.baseDirs) {
            if (sourceName === 'claude-code') baseDir = options.baseDirs.claudeCode;
            else if (sourceName === 'cursor') baseDir = options.baseDirs.cursor;
            else if (sourceName === 'gemini-cli') baseDir = options.baseDirs.geminiCli;
            else if (sourceName === 'codex') baseDir = options.baseDirs.codex;
          }

          worker.postMessage({
            task: 'inspect',
            sourceName,
            options: {
              baseDir,
              gatewayVersion: deps.gatewayVersion,
              maxDecompressedBytes: 10 * 1024 * 1024,
              captureSubAgents: true,
            },
          } as WorkerInput);
        } catch {
          resolve({
            sourceName,
            filesProcessed: 0,
            recordCount: 0,
            totalBytes: 0,
            oldestDate: null,
          });
        }
      });
    });

    const results = await Promise.all(scanPromises);
    const durationMs = performance.now() - startMs;

    let totalFiles = 0;
    let totalRecords = 0;
    let totalBytes = 0;
    let overallOldestMs = Infinity;
    let overallOldestSource = '';

    for (const r of results) {
      totalFiles += r.filesProcessed;
      totalRecords += r.recordCount;
      totalBytes += r.totalBytes;
      if (r.oldestDate) {
        const ms = Date.parse(r.oldestDate);
        if (Number.isFinite(ms) && ms < overallOldestMs) {
          overallOldestMs = ms;
          overallOldestSource = r.sourceName;
        }
      }
    }

    const oldestDateIso =
      overallOldestMs === Infinity ? null : new Date(overallOldestMs).toISOString();

    output.info(chalk.bold('📊 Telemetry Scan Summary'));
    output.info(chalk.dim('─'.repeat(80)));
    output.info(
      `${chalk.bold('Source'.padEnd(20))} │ ${chalk.bold('Scanned Files'.padStart(15))} │ ${chalk.bold('Total Records'.padStart(15))} │ ${chalk.bold('Data Size'.padStart(12))} │ ${chalk.bold('Oldest Record')}`,
    );
    output.info(chalk.dim('─'.repeat(80)));

    for (const r of results) {
      const label = formatSourceLabel(r.sourceName).padEnd(20);
      const files = r.filesProcessed.toString().padStart(15);
      const records = r.recordCount.toString().padStart(15);
      const size = formatBytes(r.totalBytes).padStart(12);
      const oldest = r.oldestDate ? formatTimeWithRelative(r.oldestDate) : chalk.dim('None');
      output.info(`${label} │ ${files} │ ${records} │ ${size} │ ${oldest}`);
    }

    output.info(chalk.dim('─'.repeat(80)));
    const totalLabel = chalk.bold('TOTAL'.padEnd(20));
    const totalFilesStr = chalk.bold(totalFiles.toString().padStart(15));
    const totalRecordsStr = chalk.bold(totalRecords.toString().padStart(15));
    const totalSizeStr = chalk.bold(formatBytes(totalBytes).padStart(12));
    const totalOldestStr = oldestDateIso
      ? chalk.bold(formatTimeWithRelative(oldestDateIso))
      : chalk.dim('None');
    output.info(
      `${totalLabel} │ ${totalFilesStr} │ ${totalRecordsStr} │ ${totalSizeStr} │ ${totalOldestStr}`,
    );
    output.info(chalk.dim('─'.repeat(80)));
    output.info('');

    output.info(chalk.bold('💡 Highlights'));
    if (oldestDateIso) {
      output.info(
        `  • Oldest telemetry record: ${chalk.green(formatTimeWithRelative(oldestDateIso))} (Source: ${chalk.cyan(formatSourceLabel(overallOldestSource))})`,
      );
    } else {
      output.info(`  • No telemetry records found.`);
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
* **Total Telemetry Records:** ${totalRecords}
* **Total Telecompressed Size:** ${formatBytes(totalBytes)}

## 📊 Summary by Telemetry Source

| Source | Scanned Files | Total Records | Data Size | Oldest Record Date |
| :--- | :---: | :---: | :---: | :--- |
${results
  .map((r) => {
    const name = formatSourceLabel(r.sourceName);
    const files = r.filesProcessed;
    const records = r.recordCount;
    const size = formatBytes(r.totalBytes);
    const oldest = r.oldestDate ? formatTimeWithRelative(r.oldestDate) : 'None';
    return `| ${name} | ${files} | ${records} | ${size} | ${oldest} |`;
  })
  .join('\n')}
| **TOTAL** | **${totalFiles}** | **${totalRecords}** | **${formatBytes(totalBytes)}** | **${oldestDateIso ? formatTimeWithRelative(oldestDateIso) : 'None'}** |

## 💡 Key Highlights

* **Oldest Telemetry Record:** ${oldestDateIso ? `${formatTimeWithRelative(oldestDateIso)} (from ${formatSourceLabel(overallOldestSource)})` : 'None found'}
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
    const durationMs = performance.now() - startMs;
    output.error(`Unexpected inspect error: ${err instanceof Error ? err.message : String(err)}`);
    output.info(chalk.dim('─'.repeat(80)));
    output.info(`✨ Inspection failed after ${chalk.bold.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info(chalk.dim('─'.repeat(80)));
    output.info('');
    return { exitCode: EXIT_CODE.error };
  }
}
