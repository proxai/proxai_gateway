import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runSetup, runSetupNew, runSetupReset } from 'cli/commands/setup';
import { buildSetupDeps, buildSetupOptions } from 'cli/wiring/setup-deps.ts';
import { resolveSetupInputs, withProfileOption } from 'cli/program/context.ts';

export function registerSetupCommands(program: Command, ctx: CLIContext): void {
  const setupCommand = withProfileOption(
    program
      .command('setup [gateway-key]')
      .alias('init')
      .description(
        'Show your gateway configuration, or run first-time setup. Pass a gateway key to configure on the first run (omit it to be prompted). When already configured, prints the gateway key and last upload and points to `setup new` / `setup reset`.',
      )
      .option(
        '--install-source <source>',
        'how this binary was installed; reported to the backend for diagnostics. One of: bun, pnpm, yarn, npm, brew, github_release.',
        'github_release',
      )
      .option(
        '--no-start',
        'finish setup without registering or starting the platform service. Run `proxai-gateway start` manually when ready.',
      ),
    ctx.isDevMode,
  );

  setupCommand.action(
    async (
      gatewayKey: string | undefined,
      opts: { installSource: string; start?: boolean; profile?: string },
    ) => {
      const inputs = await resolveSetupInputs(opts.profile, ctx.isDevMode);
      const optionsForRun = gatewayKey === undefined ? opts : { ...opts, apiKey: gatewayKey };
      const result = await runSetup(await buildSetupDeps(inputs), buildSetupOptions(optionsForRun));
      process.exit(result.exitCode);
    },
  );

  withProfileOption(
    setupCommand
      .command('new [gateway-key]')
      .description(
        'Replace the stored gateway key with a new one: re-verifies the key, rewrites the configuration, clears any auth-failure flag, and restarts the daemon. Pass the key as an argument, or run with no argument to be prompted for it.',
      )
      .option(
        '--install-source <source>',
        'how this binary was installed; reported to the backend for diagnostics.',
        'github_release',
      )
      .option('--no-start', 'finish without registering or starting the platform service.'),
    ctx.isDevMode,
  ).action(
    async (
      gatewayKey: string | undefined,
      opts: { installSource: string; start?: boolean; profile?: string },
    ) => {
      const inputs = await resolveSetupInputs(opts.profile, ctx.isDevMode);
      const optionsForRun = gatewayKey === undefined ? opts : { ...opts, apiKey: gatewayKey };
      const result = await runSetupNew(
        await buildSetupDeps(inputs),
        buildSetupOptions(optionsForRun),
      );
      process.exit(result.exitCode);
    },
  );

  withProfileOption(
    setupCommand
      .command('reset')
      .description(
        'Stop the daemon and remove the stored gateway key, returning the gateway to a waiting-for-configuration state. Buffered data and logs are kept.',
      )
      .option('-y, --yes', 'skip the confirmation prompt', false),
    ctx.isDevMode,
  ).action(async (opts: { yes?: boolean; profile?: string }) => {
    const inputs = await resolveSetupInputs(opts.profile, ctx.isDevMode);
    const result = await runSetupReset(await buildSetupDeps(inputs), { yes: opts.yes === true });
    process.exit(result.exitCode);
  });
}
