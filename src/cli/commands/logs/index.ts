import { abortableSleep } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { startKeyHandler } from 'cli/commands/status/key-handler.ts';
import {
  CLEAR_TO_END_OF_LINE,
  CLEAR_TO_END_OF_SCREEN,
  CURSOR_HOME,
  ENTER_ALT_BUFFER,
  HIDE_CURSOR,
  LEAVE_ALT_BUFFER,
  SHOW_CURSOR,
} from 'cli/commands/status/status.constants.ts';

import { parseSinceDuration } from 'cli/commands/tail/filter.ts';
import { gatherLogsFrame } from 'cli/commands/logs/gather-records.ts';
import { renderLogsFrame, renderLogsJson } from 'cli/commands/logs/render-logs.ts';
import type { LogsCommandDeps, LogsCommandOptions } from 'cli/commands/logs/logs.types.ts';

export type { LogsCommandDeps, LogsCommandOptions } from 'cli/commands/logs/logs.types.ts';

const LOGS_REFRESH_INTERVAL_MS = 2_000;

export async function runLogs(
  deps: LogsCommandDeps,
  options: LogsCommandOptions = {},
): Promise<CommandResult> {
  if (options.since !== undefined) {
    const parsed = parseSinceDuration(options.since);
    if (parsed === null) {
      deps.output.error('invalid --since duration (use formats like 1h, 30m, 24h, 7d, 60s)');
      return { exitCode: EXIT_CODE.validationError };
    }
  }

  const isStatic = options.static === true || options.json === true || options.id !== undefined;

  if (deps.buffer === null) {
    deps.output.error('buffer database is unavailable');
    return { exitCode: EXIT_CODE.error };
  }

  if (options.json === true) {
    const frame = gatherLogsFrame(deps.buffer, options);
    deps.output.info(renderLogsJson(frame));
    return { exitCode: EXIT_CODE.ok };
  }

  if (isStatic) {
    const frame = gatherLogsFrame(deps.buffer, options);
    deps.output.info(renderLogsFrame(frame, options));
    return { exitCode: EXIT_CODE.ok };
  }

  return runWatchLogs(deps, options);
}

async function runWatchLogs(
  deps: LogsCommandDeps,
  options: LogsCommandOptions,
): Promise<CommandResult> {
  const stdin = options.stdin ?? process.stdin;
  const intervalMs = options.intervalMs ?? LOGS_REFRESH_INTERVAL_MS;

  let stopped = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    keyHandler.stop();
    deps.output.info(`${SHOW_CURSOR}${LEAVE_ALT_BUFFER}`);
    if (resolveDone !== null) resolveDone();
  };

  const keyHandler = startKeyHandler({ stdin, onQuit: cleanup });

  deps.output.info(`${ENTER_ALT_BUFFER}${HIDE_CURSOR}${CURSOR_HOME}`);

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (deps.buffer === null) {
        deps.output.error('buffer database is unavailable');
        cleanup();
        return;
      }
      const frame = gatherLogsFrame(deps.buffer, options);
      const rendered = renderLogsFrame(frame, options);
      const lines = rendered.split('\n');
      const painted = lines.map((line) => `${line}${CLEAR_TO_END_OF_LINE}`).join('\n');
      deps.output.info(`${CURSOR_HOME}${painted}${CLEAR_TO_END_OF_SCREEN}`);
    } catch (err) {
      if (!stopped) {
        deps.output.error(err instanceof Error ? err.message : String(err));
      }
    }
    if (!stopped) {
      await abortableSleep(intervalMs);
      void tick();
    }
  };

  void tick();

  await done;
  return { exitCode: EXIT_CODE.ok };
}
