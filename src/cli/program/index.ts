import chalk from 'chalk';
import { Command } from 'commander';
import { join } from 'node:path';
import { readDevModeSentinel } from 'core/io/fs';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import { buildVersionString } from 'cli/wiring/version-string.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { GatewayError, PACKAGE_DESCRIPTION, PACKAGE_VERSION, UserAbortedError } from 'core/utils';

import { registerSetupCommands } from 'cli/program/setupRegistration.ts';
import { registerLifecycleCommands } from 'cli/program/lifecycleRegistration.ts';
import { registerUninstallCommand } from 'cli/program/uninstallRegistration.ts';
import { registerUpgradeCommand } from 'cli/program/upgradeRegistration.ts';
import { registerExclusionCommands } from 'cli/program/exclusionRegistration.ts';
import { registerRedactionCommands } from 'cli/program/redactionRegistration.ts';
import { registerRunnerCommands } from 'cli/program/runnerRegistration.ts';
import { registerDevCommands } from 'cli/program/devRegistration.ts';
import { registerDiagnosticsCommands } from 'cli/program/diagnosticsRegistration.ts';

function hideProfileOptions(command: Command): void {
  for (const option of command.options) {
    if (option.long === '--profile') {
      option.hideHelp(true);
    }
  }
  for (const sub of command.commands) {
    hideProfileOptions(sub);
  }
}

export async function bootstrapProgram(): Promise<void> {
  const isDevMode = await readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'));
  const ctx = { isDevMode };

  const program = new Command();
  program
    .name('proxai-gateway')
    .description(PACKAGE_DESCRIPTION)
    .version(
      buildVersionString({
        version: PACKAGE_VERSION,
        installSourcePath: buildProfileContext('prod').configFilePath,
      }),
      '-v, --version',
      'output the version and install source',
    );

  program.enablePositionalOptions();

  if (isDevMode) {
    program.option('--compact', 'simplified regular user view', false);
  }

  registerSetupCommands(program, ctx);
  registerLifecycleCommands(program, ctx);
  registerUninstallCommand(program, ctx);
  registerUpgradeCommand(program, ctx);
  registerExclusionCommands(program, ctx);
  registerRedactionCommands(program, ctx);
  registerRunnerCommands(program, ctx);
  registerDevCommands(program, ctx);
  registerDiagnosticsCommands(program, ctx);

  if (!isDevMode) {
    hideProfileOptions(program);
  }

  try {
    await program.parseAsync();
  } catch (err: unknown) {
    if (err instanceof UserAbortedError) {
      console.error(`${chalk.red('✗')} aborted ${chalk.dim('— no changes were made')}`);
      process.exit(130);
    }
    if (err instanceof GatewayError) {
      console.error(`${chalk.red('✗')} ${err.message}`);
      process.exit(EXIT_CODE.error);
    }
    if (err instanceof Error) {
      console.error(`${chalk.red('✗')} unexpected error: ${err.message}`);
      if (err.stack !== undefined) console.error(chalk.dim(err.stack));
      process.exit(EXIT_CODE.error);
    }
    console.error(`${chalk.red('✗')} unexpected error: ${String(err)}`);
    process.exit(EXIT_CODE.error);
  }
}
