import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runUninstall } from 'cli/commands/uninstall';
import { buildUninstallDeps, buildUninstallOptions } from 'cli/wiring/uninstall-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildProfileServiceContext } from 'cli/wiring/platform.ts';
import {
  exitUnsupportedPlatform,
  parseProfileName,
  withProfileOption,
} from 'cli/program/context.ts';

export function registerUninstallCommand(program: Command, ctx: CLIContext): void {
  withProfileOption(
    program
      .command('uninstall')
      .alias('rm')
      .description(
        'Stop the daemon and unregister the platform service unit. Local config and logs are preserved unless `--reset` is passed.',
      )
      .option(
        '--reset',
        'also delete ~/.proxai/proxai-gateway/ (config + buffer + sentinels), the gateway log directory, and the service unit file. Destructive: requires confirmation unless --yes is given.',
        false,
      )
      .option('-y, --yes', 'skip the interactive confirmation prompt for `--reset`', false),
    ctx.isDevMode,
  ).action(async (opts: { reset?: boolean; yes?: boolean; profile?: string }) => {
    const platform = process.platform;
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const serviceCtx = buildProfileServiceContext(platform, process.execPath, profileCtx);
    if (serviceCtx === null) exitUnsupportedPlatform('uninstall');
    const result = await runUninstall(
      buildUninstallDeps({
        platform,
        programPath: process.execPath,
        serviceUnitPath: serviceCtx.unitPath,
        serviceManager: serviceCtx.serviceManager,
        profileCtx,
      }),
      buildUninstallOptions(opts),
    );
    process.exit(result.exitCode);
  });
}
