import { rm } from 'node:fs/promises';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';

export interface UninstallCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configDir: string;
  serviceUnitPath: string | null;
  configExists: () => Promise<boolean>;
}

export interface UninstallCommandOptions {
  yes?: boolean;
}

export async function runUninstall(
  deps: UninstallCommandDeps,
  options: UninstallCommandOptions = {},
): Promise<CommandResult> {
  if (!(await deps.configExists())) {
    deps.output.warn('not installed; nothing to uninstall');
    return { exitCode: EXIT_CODE.notInstalled };
  }

  if (options.yes !== true) {
    const confirmed = await deps.prompts.confirmUninstall(
      `Remove all gateway state at ${deps.configDir}?`,
    );
    if (!confirmed) {
      deps.output.info('uninstall aborted');
      return { exitCode: EXIT_CODE.ok };
    }
  }

  await rm(deps.configDir, { recursive: true, force: true });
  if (deps.serviceUnitPath !== null) {
    await rm(deps.serviceUnitPath, { force: true });
  }

  deps.output.success('uninstalled');
  return { exitCode: EXIT_CODE.ok };
}
