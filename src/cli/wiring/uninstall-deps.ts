import { join } from 'node:path';
import { homedir } from 'node:os';

import { createDefaultBinaryRemover } from 'cli/commands/binary-remove.ts';
import { createDefaultShellPathCleaner } from 'cli/commands/path-cleanup.ts';
import type { UninstallCommandDeps, UninstallCommandOptions } from 'cli/commands/uninstall.ts';
import { createDefaultSweep } from 'cli/commands/uninstall-sweep.ts';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { configDir, configFilePath, logDir } from 'core/io/fs';

export interface BuildUninstallDepsInputs {
  platform: NodeJS.Platform;
  programPath: string;
  serviceUnitPath: string;
  serviceManager: ServiceManager;
}

export function buildUninstallDeps(inputs: BuildUninstallDepsInputs): UninstallCommandDeps {
  return {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    configPath: configFilePath(),
    configDir: configDir(),
    logDir: logDir(),
    serviceUnitPath: inputs.serviceUnitPath,
    serviceManager: inputs.serviceManager,
    configExists: () => Bun.file(configFilePath()).exists(),
    sweep: createDefaultSweep(),
    binaryRemover: createDefaultBinaryRemover(inputs.platform),
    pathCleaner: createDefaultShellPathCleaner(inputs.platform),
    installDir: join(homedir(), '.proxai', 'bin'),
    currentExecPath: inputs.programPath,
  };
}

export function buildUninstallOptions(opts: {
  reset?: boolean;
  yes?: boolean;
}): UninstallCommandOptions {
  const out: UninstallCommandOptions = {};
  if (opts.reset === true) out.reset = true;
  if (opts.yes === true) out.yes = true;
  return out;
}
