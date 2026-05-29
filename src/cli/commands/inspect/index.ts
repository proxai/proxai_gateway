import chalk from 'chalk';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { formatSourceLabel } from 'cli/commands/status/layout.ts';

import { INSPECT_SOURCES } from 'cli/commands/inspect/inspect.constants.ts';
import {
  renderDiskTable,
  renderHighlights,
  renderUploadTable,
  renderWarnings,
} from 'cli/commands/inspect/layout.ts';
import {
  buildMarkdownReport,
  resolveReportPath,
  writeMarkdownReport,
} from 'cli/commands/inspect/report.ts';
import { scanSingleSource } from 'cli/commands/inspect/scan.ts';
import { createSpinner } from 'cli/commands/inspect/spinner.ts';
import { aggregateResults, collectWarnings } from 'cli/commands/inspect/summary.ts';
import type {
  InspectCommandDeps,
  InspectCommandOptions,
  SourceResult,
} from 'cli/commands/inspect/inspect.types.ts';

export type {
  InspectBaseDirs,
  InspectCommandDeps,
  InspectCommandOptions,
} from 'cli/commands/inspect/inspect.types.ts';

export async function runInspect(
  deps: InspectCommandDeps,
  options: InspectCommandOptions = {},
): Promise<CommandResult> {
  const { output } = deps;
  const cols = process.stdout.columns;
  const terminalWidth = typeof cols === 'number' && cols > 0 ? Math.min(80, cols) : 80;
  const RULE = '─'.repeat(terminalWidth);

  output.info(chalk.bold('ProxAI Telemetry Dry-Run Inspection'));
  output.info('');

  const startMs = performance.now();
  const spinner = createSpinner(process.stdout, process.stdout.isTTY === true);

  try {
    spinner.start('Initializing inspection...');
    const results: SourceResult[] = [];
    for (const sourceName of INSPECT_SOURCES) {
      spinner.update(`Scanning ${chalk.yellow(formatSourceLabel(sourceName))}...`);
      results.push(await scanSingleSource(sourceName, deps, options));
    }
    spinner.stop();

    const durationMs = performance.now() - startMs;
    const summary = aggregateResults(results);
    const warnings = collectWarnings(results);

    for (const line of renderDiskTable(results, summary)) {
      output.info(line);
    }
    output.info('');
    for (const line of renderUploadTable(results, summary)) {
      output.info(line);
    }
    output.info('');

    const warningLines = renderWarnings(warnings);
    for (const line of warningLines) {
      output.info(line);
    }
    if (warningLines.length > 0) {
      output.info('');
    }

    for (const line of renderHighlights(summary, durationMs)) {
      output.info(line);
    }
    output.info('');

    const now = new Date();
    const reportPath = resolveReportPath(now);
    const markdown = buildMarkdownReport({ results, summary, warnings, durationMs, now });
    try {
      await writeMarkdownReport(reportPath, markdown);
      output.success(`Beautiful dry-run markdown report saved to: ${chalk.cyan(reportPath)}`);
    } catch (err) {
      output.error(
        `Failed to save markdown report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    output.info(chalk.dim(RULE));
    output.info(`Inspection completed in ${chalk.bold.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info(chalk.dim(RULE));
    output.info('');
    return { exitCode: EXIT_CODE.ok };
  } catch (err) {
    spinner.stop();
    const durationMs = performance.now() - startMs;
    output.error(`Unexpected inspect error: ${err instanceof Error ? err.message : String(err)}`);
    output.info(chalk.dim(RULE));
    output.info(`Inspection failed after ${chalk.bold.yellow(durationMs.toFixed(2) + ' ms')}`);
    output.info(chalk.dim(RULE));
    output.info('');
    return { exitCode: EXIT_CODE.error };
  }
}
