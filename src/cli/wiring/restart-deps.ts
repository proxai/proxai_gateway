import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { RestartCommandDeps } from 'cli/commands/restart.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit/writer.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export interface BuildRestartDepsInputs {
  serviceManager: ServiceManager;
  serviceUnitRecreate: ServiceUnitRecreateConfig;
  invokeSetup: () => Promise<CommandResult>;
  profileCtx: ProfileContext;
  output?: OutputSink;
}

export function buildRestartDeps(inputs: BuildRestartDepsInputs): RestartCommandDeps {
  return {
    output: inputs.output ?? consoleOutput(),
    configExists: () => Bun.file(inputs.profileCtx.configFilePath).exists(),
    serviceManager: inputs.serviceManager,
    sessionStoppedSentinelPath: inputs.profileCtx.sentinels.sessionStopped,
    invokeSetup: inputs.invokeSetup,
    serviceUnitRecreate: inputs.serviceUnitRecreate,
    profileName: inputs.profileCtx.name,
  };
}
