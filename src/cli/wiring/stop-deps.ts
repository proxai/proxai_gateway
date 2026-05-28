import type { StopCommandDeps } from 'cli/commands/stop.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export interface BuildStopDepsInputs {
  serviceManager: ServiceManager;
  profileCtx: ProfileContext;
}

export function buildStopDeps(inputs: BuildStopDepsInputs): StopCommandDeps {
  return {
    output: consoleOutput(),
    serviceManager: inputs.serviceManager,
    sessionStoppedSentinelPath: inputs.profileCtx.sentinels.sessionStopped,
  };
}
