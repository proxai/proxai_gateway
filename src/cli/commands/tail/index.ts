import chalk from 'chalk';

import { VALID_LOG_LEVELS } from 'core/log';
import { abortableSleep } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';

import { resolveFilters } from 'cli/commands/tail/filter.ts';
import { formatLine } from 'cli/commands/tail/format.ts';
import { todaysLogPath } from 'cli/commands/tail/log-path.ts';
import { readMatchingFrom, readMatchingTail } from 'cli/commands/tail/read.ts';
import type { TailCommandDeps, TailCommandOptions } from 'cli/commands/tail/tail.types.ts';

export type { TailCommandDeps, TailCommandOptions } from 'cli/commands/tail/tail.types.ts';
export { todaysLogPath } from 'cli/commands/tail/log-path.ts';
export { formatLine } from 'cli/commands/tail/format.ts';

const POLL_INTERVAL_MS = 200;

export async function runTail(
  deps: TailCommandDeps,
  options: TailCommandOptions = {},
): Promise<CommandResult> {
  const filters = resolveFilters(options);
  if (filters === null) {
    deps.output.error('invalid --since duration (use formats like 1h, 30m, 24h, 7d, 60s)');
    return { exitCode: EXIT_CODE.validationError };
  }
  if (options.level !== undefined && !VALID_LOG_LEVELS.includes(options.level)) {
    deps.output.error(`invalid --level: must be one of ${VALID_LOG_LEVELS.join(', ')}`);
    return { exitCode: EXIT_CODE.validationError };
  }

  const isStatic = options.static === true;
  const lineLimit = options.lines ?? 50;
  const raw = options.raw === true;
  const emit = deps.emit;

  const resolvePath = deps.pathProvider ?? ((): string => todaysLogPath(deps.logDir));
  let path = resolvePath();
  let position = 0;

  const initialExists = await Bun.file(path).exists();
  if (!initialExists) {
    if (!isStatic) {
      deps.output.info(chalk.dim('Waiting for daemon to start writing logs...'));
    } else if (!raw) {
      deps.output.info(chalk.dim('No logs yet. Start the daemon with `proxai-gateway start`.'));
    }
  }

  const initial = await readMatchingTail(path, lineLimit, filters);
  position = initial.endPosition;
  for (const line of initial.lines) {
    emit(raw ? line : formatLine(line));
  }

  if (isStatic) {
    return { exitCode: EXIT_CODE.ok };
  }

  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  let logArrivedNotified = initialExists;
  while (deps.abortSignal === undefined || !deps.abortSignal.aborted) {
    await abortableSleep(pollIntervalMs, deps.abortSignal);
    if (deps.abortSignal !== undefined && deps.abortSignal.aborted) break;

    const currentPath = resolvePath();
    if (currentPath !== path) {
      path = currentPath;
      position = 0;
      logArrivedNotified = false;
    }

    if (!logArrivedNotified) {
      const exists = await Bun.file(path).exists();
      if (!exists) continue;
      deps.output.info(chalk.dim('Log file appeared; streaming...'));
      logArrivedNotified = true;
    }

    const next = await readMatchingFrom(path, position, filters);
    position = next.endPosition;
    for (const line of next.lines) {
      emit(raw ? line : formatLine(line));
    }
  }

  return { exitCode: EXIT_CODE.ok };
}
