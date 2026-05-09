import type { CommandResult } from 'cli/cli.types.ts';
import type { RestartCommandDeps } from 'cli/commands/restart.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit/writer.ts';
import { configFilePath, sessionStoppedSentinelPath } from 'core/io/fs';

export interface BuildRestartDepsInputs {
  serviceManager: ServiceManager;
  serviceUnitRecreate: ServiceUnitRecreateConfig;
  invokeSetup: () => Promise<CommandResult>;
}

export function buildRestartDeps(inputs: BuildRestartDepsInputs): RestartCommandDeps {
  return {
    output: consoleOutput(),
    configExists: () => Bun.file(configFilePath()).exists(),
    serviceManager: inputs.serviceManager,
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    invokeSetup: inputs.invokeSetup,
    serviceUnitRecreate: inputs.serviceUnitRecreate,
  };
}
