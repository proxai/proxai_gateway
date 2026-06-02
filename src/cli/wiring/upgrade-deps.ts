import type { UpgradeCommandDeps, UpgradeCommandOptions } from 'cli/commands/upgrade.ts';
import { consoleOutput } from 'cli/output.ts';
import { PACKAGE_VERSION } from 'core/utils';

export interface BuildUpgradeDepsInputs {
  binaryPath: string;
  restartDaemon?: () => Promise<boolean>;
}

export function buildUpgradeDeps(inputs: BuildUpgradeDepsInputs): UpgradeCommandDeps {
  const deps: UpgradeCommandDeps = {
    output: consoleOutput(),
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
  };
  if (inputs.restartDaemon !== undefined) deps.restartDaemon = inputs.restartDaemon;
  return deps;
}

export function buildUpgradeOptions(opts: { force?: boolean }): UpgradeCommandOptions {
  const out: UpgradeCommandOptions = {};
  if (opts.force === true) out.force = true;
  return out;
}
