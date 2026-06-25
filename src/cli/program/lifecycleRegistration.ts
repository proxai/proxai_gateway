import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runStart } from 'cli/commands/start.ts';
import { runStop } from 'cli/commands/stop.ts';
import { runRestart } from 'cli/commands/restart.ts';
import { buildStartDeps } from 'cli/wiring/start-deps.ts';
import { buildStopDeps } from 'cli/wiring/stop-deps.ts';
import { buildRestartDeps } from 'cli/wiring/restart-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildProfileServiceContext, buildServiceUnitRecreate } from 'cli/wiring/platform.ts';
import {
  exitUnsupportedPlatform,
  parseProfileName,
  withProfileOption,
} from 'cli/program/context.ts';
import { invokeSetupInteractive } from 'cli/wiring/setup-deps.ts';
import { autoUpgradeFromConfig } from 'cli/wiring/auto-upgrade.ts';
import { PACKAGE_VERSION } from 'core/utils';
import { loadConfigFromFile } from 'services/config';

export function registerLifecycleCommands(program: Command, ctx: CLIContext): void {
  withProfileOption(
    program
      .command('start')
      .alias('s')
      .description(
        'Register the gateway as a managed service (launchd / systemd / Scheduled Task) and start the daemon. Auto-restarts on reboot. Requires a prior `setup`.',
      ),
    ctx.isDevMode,
  ).action(async (opts: { profile?: string }) => {
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const serviceCtx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
    if (serviceCtx === null) exitUnsupportedPlatform('start');
    const setupInputs = {
      platform: serviceCtx.platform,
      programPath: process.execPath,
      serviceUnitPath: serviceCtx.unitPath,
      serviceManager: serviceCtx.serviceManager,
      env: process.env,
      profileCtx,
    };
    const result = await runStart(
      buildStartDeps({
        serviceManager: serviceCtx.serviceManager,
        serviceUnitRecreate: buildServiceUnitRecreate(
          serviceCtx.platform,
          serviceCtx.unitPath,
          process.execPath,
          process.env,
        ),
        invokeSetup: invokeSetupInteractive(setupInputs),
        runAutoUpgrade: () =>
          autoUpgradeFromConfig({
            binaryPath: process.execPath,
            currentVersion: PACKAGE_VERSION,
            devMode: false,
            loadConfig: () => loadConfigFromFile(profileCtx.configFilePath),
            exitProcess: () => process.exit(0),
          }),
        profileCtx,
      }),
    );
    process.exit(result.exitCode);
  });

  withProfileOption(
    program
      .command('stop')
      .alias('x')
      .description(
        'Halt the running gateway daemon for this session. The service remains registered and will start again automatically on next reboot. Use `uninstall` to fully decommission.',
      ),
    ctx.isDevMode,
  ).action(async (opts: { profile?: string }) => {
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const serviceCtx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
    if (serviceCtx === null) exitUnsupportedPlatform('stop');
    const result = await runStop(
      buildStopDeps({
        serviceManager: serviceCtx.serviceManager,
        profileCtx,
      }),
    );
    process.exit(result.exitCode);
  });

  withProfileOption(
    program
      .command('restart')
      .alias('r')
      .description('Stop and start the gateway daemon. Equivalent to `stop` followed by `start`.'),
    ctx.isDevMode,
  ).action(async (opts: { profile?: string }) => {
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const serviceCtx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
    if (serviceCtx === null) exitUnsupportedPlatform('restart');
    const setupInputs = {
      platform: serviceCtx.platform,
      programPath: process.execPath,
      serviceUnitPath: serviceCtx.unitPath,
      serviceManager: serviceCtx.serviceManager,
      env: process.env,
      profileCtx,
    };
    const result = await runRestart(
      buildRestartDeps({
        serviceManager: serviceCtx.serviceManager,
        serviceUnitRecreate: buildServiceUnitRecreate(
          serviceCtx.platform,
          serviceCtx.unitPath,
          process.execPath,
          process.env,
        ),
        invokeSetup: invokeSetupInteractive(setupInputs),
        profileCtx,
      }),
    );
    process.exit(result.exitCode);
  });
}
