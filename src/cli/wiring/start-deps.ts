import type { CommandResult } from 'cli/cli.types.ts';
import type { StartCommandDeps } from 'cli/commands/start.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit-writer.ts';
import { configFilePath, sessionStoppedSentinelPath } from 'core/io/fs';

export interface BuildStartDepsInputs {
  serviceManager: ServiceManager;
  serviceUnitRecreate: ServiceUnitRecreateConfig;
  invokeSetup: () => Promise<CommandResult>;
  runAutoUpgrade: () => Promise<void>;
}

export function buildStartDeps(inputs: BuildStartDepsInputs): StartCommandDeps {
  return {
    output: consoleOutput(),
    configExists: () => Bun.file(configFilePath()).exists(),
    serviceManager: inputs.serviceManager,
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    invokeSetup: inputs.invokeSetup,
    serviceUnitRecreate: inputs.serviceUnitRecreate,
    runAutoUpgrade: inputs.runAutoUpgrade,
  };
}
