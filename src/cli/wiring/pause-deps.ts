import type { PauseCommandDeps, PauseCommandOptions } from 'cli/commands/pause.ts';
import { consoleOutput } from 'cli/output.ts';
import { pausedSentinelPath } from 'core/io/fs';

export function buildPauseDeps(): PauseCommandDeps {
  return {
    output: consoleOutput(),
    sentinelPath: pausedSentinelPath(),
  };
}

export function buildPauseOptions(opts: { reason?: string }): PauseCommandOptions {
  const out: PauseCommandOptions = {};
  if (opts.reason !== undefined) out.reason = opts.reason;
  return out;
}
