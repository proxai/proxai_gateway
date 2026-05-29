import chalk from 'chalk';
import type { ReplayReport } from 'cli/commands/replay/replay.types.ts';

export function renderReport(report: ReplayReport): string {
  if (report.totalEvents === 0) {
    return 'No state-machine transitions found in the log.';
  }
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const divider = chalk.dim('─'.repeat(cols));
  const lines: string[] = [];
  lines.push(divider);
  lines.push(chalk.bold('Replay summary'));
  lines.push(
    `  ${chalk.dim('Events:')} ${report.totalEvents.toString()}  ${chalk.dim('Machines:')} ${report.machineCount.toString()}`,
  );
  lines.push(divider);
  lines.push(chalk.bold('Final state per machine'));
  for (const m of report.machines) {
    lines.push(
      `  ${chalk.cyan(m.machine)} ${chalk.dim(`(${m.transitionCount.toString()} transitions, ${m.finalStatus})`)}`,
    );
    lines.push(`    ${chalk.dim('value:')} ${stringifyValue(m.finalValue)}`);
    lines.push(`    ${chalk.dim('first:')} ${m.firstAtUtc}`);
    lines.push(`    ${chalk.dim('last:')}  ${m.lastAtUtc}`);
  }
  lines.push(divider);
  return lines.join('\n');
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
