import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runUpgrade } from 'cli/commands/upgrade.ts';
import { runRestart } from 'cli/commands/restart.ts';
import { buildUpgradeDeps } from 'cli/wiring/upgrade-deps.ts';
import { buildRestartDeps } from 'cli/wiring/restart-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildProfileServiceContext, buildServiceUnitRecreate } from 'cli/wiring/platform.ts';
import { parseProfileName, withProfileOption } from 'cli/program/context.ts';
import { silentOutput } from 'cli/output.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';

export function registerUpgradeCommand(program: Command, ctx: CLIContext): void {
  withProfileOption(
    program
      .command('upgrade')
      .alias('update')
      .description(
        'Fetch the latest gateway release from GitHub, replace the binary, and restart the daemon so the new version is applied automatically.',
      )
      .option(
        '--force',
        'install the latest release even when it is not detected as newer than the current version',
        false,
      ),
    ctx.isDevMode,
  ).action(async (opts: { profile?: string; force?: boolean }) => {
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const serviceCtx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
    let restartDaemon: (() => Promise<boolean>) | undefined;
    if (serviceCtx !== null) {
      restartDaemon = async () => {
        const restartResult = await runRestart(
          buildRestartDeps({
            serviceManager: serviceCtx.serviceManager,
            serviceUnitRecreate: buildServiceUnitRecreate(
              serviceCtx.platform,
              serviceCtx.unitPath,
              process.execPath,
              process.env,
            ),
            invokeSetup: () => Promise.resolve({ exitCode: EXIT_CODE.error }),
            profileCtx,
            output: silentOutput(),
          }),
        );
        return restartResult.exitCode === EXIT_CODE.ok;
      };
    }
    const result = await runUpgrade(
      buildUpgradeDeps({
        binaryPath: process.execPath,
        ...(restartDaemon !== undefined ? { restartDaemon } : {}),
      }),
      { force: opts.force === true },
    );
    process.exit(result.exitCode);
  });
}
