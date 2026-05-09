import type { UpgradeCommandDeps, UpgradeCommandOptions } from 'cli/commands/upgrade.ts';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import { PACKAGE_VERSION } from 'core/utils';

export interface BuildUpgradeDepsInputs {
  binaryPath: string;
}

export function buildUpgradeDeps(inputs: BuildUpgradeDepsInputs): UpgradeCommandDeps {
  return {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
  };
}

export function buildUpgradeOptions(opts: {
  yes?: boolean;
  force?: boolean;
}): UpgradeCommandOptions {
  const out: UpgradeCommandOptions = {};
  if (opts.yes === true) out.yes = true;
  if (opts.force === true) out.force = true;
  return out;
}
