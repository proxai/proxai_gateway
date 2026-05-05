import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { isPaused, resumePolling } from 'services/polling';

export interface ResumeCommandDeps {
  output: OutputSink;
  sentinelPath: string;
}

export async function runResume(deps: ResumeCommandDeps): Promise<CommandResult> {
  const wasPaused = await isPaused(deps.sentinelPath);
  await resumePolling(deps.sentinelPath);
  if (wasPaused) {
    deps.output.success('resumed');
  } else {
    deps.output.info('not paused; nothing to do');
  }
  return { exitCode: EXIT_CODE.ok };
}
