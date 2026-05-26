import { readFile } from 'node:fs/promises';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { buildReport } from 'cli/commands/replay/build-report.ts';
import { parseLog } from 'cli/commands/replay/parse-log.ts';
import { renderReport } from 'cli/commands/replay/render-report.ts';
import type { ReplayDeps, ReplayOptions } from 'cli/commands/replay/replay.types.ts';

export type {
  ReplayEvent,
  ReplayMachineSummary,
  ReplayReport,
  ReplayDeps,
  ReplayOptions,
} from 'cli/commands/replay/replay.types.ts';
export { parseLog } from 'cli/commands/replay/parse-log.ts';
export { buildReport } from 'cli/commands/replay/build-report.ts';
export { renderReport } from 'cli/commands/replay/render-report.ts';

export async function runReplay(deps: ReplayDeps, options: ReplayOptions): Promise<CommandResult> {
  let body: string;
  try {
    body = await deps.readFile(options.logPath);
  } catch (err) {
    deps.output.error(`failed to read log: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: EXIT_CODE.error };
  }
  const events = parseLog(body);
  const report = buildReport(events, options.machine);
  deps.output.info(renderReport(report));
  return { exitCode: EXIT_CODE.ok };
}

export const defaultReplayDeps: ReplayDeps = {
  output: {
    info: (m) => process.stdout.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
    success: (m) => process.stdout.write(`${m}\n`),
  },
  readFile: (path) => readFile(path, 'utf8'),
};
