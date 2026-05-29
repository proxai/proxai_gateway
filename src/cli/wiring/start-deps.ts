import type { CommandResult } from 'cli/cli.types.ts';
import type { StartCommandDeps } from 'cli/commands/start.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit/writer.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export interface BuildStartDepsInputs {
  serviceManager: ServiceManager;
  serviceUnitRecreate: ServiceUnitRecreateConfig;
  invokeSetup: () => Promise<CommandResult>;
  runAutoUpgrade: () => Promise<void>;
  profileCtx: ProfileContext;
}

export function buildStartDeps(inputs: BuildStartDepsInputs): StartCommandDeps {
  return {
    output: consoleOutput(),
    configExists: () => Bun.file(inputs.profileCtx.configFilePath).exists(),
    serviceManager: inputs.serviceManager,
    sessionStoppedSentinelPath: inputs.profileCtx.sentinels.sessionStopped,
    invokeSetup: inputs.invokeSetup,
    serviceUnitRecreate: inputs.serviceUnitRecreate,
    runAutoUpgrade: inputs.runAutoUpgrade,
    profileName: inputs.profileCtx.name,
  };
}
