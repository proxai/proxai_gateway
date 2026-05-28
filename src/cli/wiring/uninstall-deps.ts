import { join } from 'node:path';
import { homedir } from 'node:os';

import { createDefaultBinaryRemover } from 'services/uninstall';
import { createDefaultShellPathCleaner } from 'services/uninstall';
import type { UninstallCommandDeps, UninstallCommandOptions } from 'cli/commands/uninstall';
import { createDefaultSweep } from 'services/uninstall';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export interface BuildUninstallDepsInputs {
  platform: NodeJS.Platform;
  programPath: string;
  serviceUnitPath: string;
  serviceManager: ServiceManager;
  profileCtx: ProfileContext;
}

export function buildUninstallDeps(inputs: BuildUninstallDepsInputs): UninstallCommandDeps {
  const { profileCtx } = inputs;
  return {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    configPath: profileCtx.configFilePath,
    configDir: profileCtx.configDir,
    logDir: profileCtx.logDir,
    serviceUnitPath: inputs.serviceUnitPath,
    serviceManager: inputs.serviceManager,
    configExists: () => Bun.file(profileCtx.configFilePath).exists(),
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
