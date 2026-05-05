import chalk from 'chalk';

import type { OutputSink } from 'cli/cli.types.ts';

export function consoleOutput(): OutputSink {
  return {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(chalk.yellow(`! ${msg}`)),
    error: (msg) => console.error(chalk.red(`x ${msg}`)),
    success: (msg) => console.log(chalk.green(`+ ${msg}`)),
  };
}

export function silentOutput(): OutputSink {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
  };
}

export function captureOutput(): OutputSink & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
    success: (msg) => lines.push({ level: 'success', msg }),
  };
}
