import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager.ts';

export interface StartCommandDeps {
  output: OutputSink;
  configExists: () => Promise<boolean>;
  serviceManager: ServiceManager;
  invokeSetup?: () => Promise<CommandResult>;
}

export async function runStart(deps: StartCommandDeps): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    deps.output.warn('no configuration detected — entering first-time setup');
    if (deps.invokeSetup === undefined) {
      deps.output.error('setup is unavailable in this context');
      return { exitCode: EXIT_CODE.error };
    }
    return deps.invokeSetup();
  }
  try {
    await deps.serviceManager.ensureRegistered();
    await deps.serviceManager.start();
    deps.output.success('proxai-gateway started');
    return { exitCode: EXIT_CODE.ok };
  } catch (err) {
    deps.output.error(formatError('start failed', err));
    return { exitCode: EXIT_CODE.error };
  }
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof Error) return `${prefix}: ${err.message}`;
  return `${prefix}: ${String(err)}`;
}
