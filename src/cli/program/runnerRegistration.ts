import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runDaemon } from 'cli/commands/run';
import { refreshServiceUnitIfLegacy } from 'cli/commands/run/service-unit-refresh.ts';
import { runDaemonStartupRelocation } from 'cli/commands/run/startup-relocation.ts';
import { runRescue } from 'cli/commands/rescue/index.ts';
import { ensureWatchdogUnitExists } from 'cli/service-unit/watchdog-writer.ts';
import { buildRunDeps } from 'cli/wiring/run-deps.ts';
import {
  buildProfileServiceContext,
  buildWatchdogServiceContext,
  resolveWindowsUserId,
} from 'cli/wiring/platform.ts';
import { buildUpgradePostRespawnRestoreDeps } from 'cli/wiring/upgrade-restore-deps.ts';
import { runUpgradePostRespawnRestore } from 'services/upgrade/coordinated-upgrade.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { loadConfigFromFile } from 'services/config';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import {
  parseProfileNameInternal,
  parseProfileName,
  requireDevMode,
  withProfileOption,
} from 'cli/program/context.ts';

export function registerRunnerCommands(program: Command, ctx: CLIContext): void {
  program
    .command('run', { hidden: true })
    .description(
      'Run the gateway daemon in the foreground (used by the service unit; not for direct invocation).',
    )
    .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
    .option('--profile <name>', 'profile to run as (prod | dev)', 'prod')
    .action(async (opts: { config?: string; profile?: string }) => {
      await runDaemonStartupRelocation();
      const profileName = parseProfileNameInternal(opts.profile);
      const profileCtx = buildProfileContext(profileName);
      const platformCtx = buildProfileServiceContext(
        process.platform,
        process.execPath,
        profileCtx,
      );
      if (platformCtx !== null) {
        const windowsUserId =
          platformCtx.platform === 'win32' ? resolveWindowsUserId(process.env) : undefined;
        const refreshConfig =
          windowsUserId !== undefined
            ? {
                serviceUnitPath: platformCtx.unitPath,
                programPath: process.execPath,
                platform: platformCtx.platform,
                profileName,
                windowsUserId,
              }
            : {
                serviceUnitPath: platformCtx.unitPath,
                programPath: process.execPath,
                platform: platformCtx.platform,
                profileName,
              };
        await refreshServiceUnitIfLegacy(refreshConfig);
        const watchdogCtx = buildWatchdogServiceContext(
          platformCtx.platform,
          process.execPath,
          profileCtx,
        );
        if (watchdogCtx !== null) {
          try {
            await ensureWatchdogUnitExists({
              platform: platformCtx.platform,
              profileName,
              programPath: process.execPath,
              ...watchdogCtx.watchdogUnitPaths,
            });
            await watchdogCtx.watchdogManager.install();
          } catch {}
        }
      }
      if (!profileCtx.isDev) {
        try {
          await runUpgradePostRespawnRestore(
            buildUpgradePostRespawnRestoreDeps({ platform: process.platform }),
          );
        } catch {}
      }
      const config = await loadConfigFromFile(opts.config ?? profileCtx.configFilePath);
      const ctrl = new AbortController();
      process.on('SIGINT', () => ctrl.abort());
      process.on('SIGTERM', () => ctrl.abort());
      const result = await runDaemon(
        buildRunDeps({
          config,
          abortSignal: ctrl.signal,
          binaryPath: process.execPath,
          exitProcess: () => process.exit(EXIT_CODE.upgradeRespawn),
          profileCtx,
        }),
      );
      process.exit(result.exitCode);
    });

  program
    .command('rescue', { hidden: true })
    .description('Rescue/restart the daemon if it is wedged or crashed.')
    .option('--profile <name>', 'profile to rescue (prod | dev)', 'prod')
    .action(async (opts: { profile?: string }) => {
      const profileName = parseProfileNameInternal(opts.profile);
      const result = await runRescue({
        profileName,
        programPath: process.execPath,
      });
      process.exit(result.exitCode);
    });

  withProfileOption(
    program
      .command('xstate', { hidden: !ctx.isDevMode })
      .description(
        'Start the gateway daemon in the foreground with the Stately browser visualizer enabled.',
      )
      .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path'),
    ctx.isDevMode,
  ).action(async (opts: { config?: string; profile?: string }) => {
    requireDevMode('xstate', ctx.isDevMode);
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const config = await loadConfigFromFile(opts.config ?? profileCtx.configFilePath);
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    process.on('SIGTERM', () => ctrl.abort());

    const result = await runDaemon(
      buildRunDeps({
        config,
        abortSignal: ctrl.signal,
        binaryPath: process.execPath,
        exitProcess: () => process.exit(EXIT_CODE.upgradeRespawn),
        xstateInspect: true,
        profileCtx,
      }),
    );
    process.exit(result.exitCode);
  });
}
