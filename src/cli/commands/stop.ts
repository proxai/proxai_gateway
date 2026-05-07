import { readBootId } from 'core/system';
import { nowIsoUtc } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { writeSessionStoppedSentinel } from 'services/polling';

export interface StopCommandDeps {
  output: OutputSink;
  serviceManager: ServiceManager;
  sessionStoppedSentinelPath: string;
  readBootId?: () => Promise<string>;
  now?: () => string;
}

export async function runStop(deps: StopCommandDeps): Promise<CommandResult> {
  try {
    const readBootIdFn = deps.readBootId ?? readBootId;
    const now = deps.now ?? nowIsoUtc;
    const currentBootId = await readBootIdFn();
    await writeSessionStoppedSentinel(deps.sessionStoppedSentinelPath, {
      bootId: currentBootId,
      setAt: now(),
    });

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
