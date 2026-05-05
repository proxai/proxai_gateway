import { ensureDir } from 'core/io/fs';
import { dirname } from 'node:path';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { pausePolling } from 'services/polling';

export interface PauseCommandDeps {
  output: OutputSink;
  sentinelPath: string;
}

export interface PauseCommandOptions {
  reason?: string;
}

export async function runPause(
  deps: PauseCommandDeps,
  options: PauseCommandOptions = {},
): Promise<CommandResult> {
  await ensureDir(dirname(deps.sentinelPath));
  const reason = options.reason ?? '';
  await pausePolling(deps.sentinelPath, reason);
  if (reason.length > 0) {
    deps.output.success(`paused (reason: ${reason})`);
  } else {
    deps.output.success('paused');
  }
  return { exitCode: EXIT_CODE.ok };
}
