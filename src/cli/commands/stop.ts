import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager.ts';

export interface StopCommandDeps {
  output: OutputSink;
  serviceManager: ServiceManager;
}

export async function runStop(deps: StopCommandDeps): Promise<CommandResult> {
  try {
    const registered = await deps.serviceManager.isRegistered();
    if (!registered) {
      deps.output.info('proxai-gateway is not registered');
      return { exitCode: EXIT_CODE.ok };
    }
    await deps.serviceManager.stop();
    deps.output.success('proxai-gateway stopped');
    return { exitCode: EXIT_CODE.ok };
  } catch (err) {
    deps.output.error(formatError('stop failed', err));
    return { exitCode: EXIT_CODE.error };
  }
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof Error) return `${prefix}: ${err.message}`;
  return `${prefix}: ${String(err)}`;
}
