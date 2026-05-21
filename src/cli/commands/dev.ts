import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { sentinelHandle } from 'core/io/fs';

export interface DevCommandDeps {
  output: OutputSink;
  sentinelPath: string;
}

export async function runDev(deps: DevCommandDeps, action?: string): Promise<CommandResult> {
  const handle = sentinelHandle(deps.sentinelPath);
  const exists = await handle.exists();

  let targetState: boolean;

  if (action === 'on') {
    targetState = true;
  } else if (action === 'off') {
    targetState = false;
  } else if (action === undefined || action.trim() === '') {
    targetState = !exists;
  } else {
    deps.output.error(`Invalid action: '${action}'. Expected 'on', 'off', or no action to toggle.`);
    return { exitCode: EXIT_CODE.error };
  }

  if (targetState) {
    await handle.write('ENABLED');
    deps.output.success('Dev mode enabled (ingestion endpoint forced to http://localhost:3001).');
  } else {
    await handle.remove();
    deps.output.success('Dev mode disabled (ingestion endpoint restored to production).');
  }

  return { exitCode: EXIT_CODE.ok };
}
