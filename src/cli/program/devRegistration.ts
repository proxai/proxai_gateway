import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runDev } from 'cli/commands/dev.ts';
import { defaultReplayDeps, runReplay } from 'cli/commands/replay';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';
import { requireDevMode, parseProfileName, withProfileOption } from 'cli/program/context.ts';

export function registerDevCommands(program: Command, ctx: CLIContext): void {
  program
    .command('dev [action] [key]', { hidden: !ctx.isDevMode })
    .alias('d')
    .description(
      'Manage gateway development mode. Actions: "on", "off", "setup <KEY>", or no action to toggle.',
    )
    .action(async (action?: string, key?: string) => {
      const result = await runDev(
        buildDevDeps(),
        action,
        key !== undefined ? { apiKey: key } : undefined,
      );
      process.exit(result.exitCode);
    });

  withProfileOption(
    program
      .command('replay <logPath>', { hidden: !ctx.isDevMode })
      .description(
        'Replay a JSONL log of state-machine transitions and print the final state per machine. Useful for incident debugging.',
      )
      .option('--machine <name>', 'limit the replay to a single machine'),
    ctx.isDevMode,
  ).action(async (logPath: string, opts: { machine?: string; profile?: string }) => {
    requireDevMode('replay', ctx.isDevMode);
    parseProfileName(opts.profile, ctx.isDevMode);
    const replayOptions: { logPath: string; machine?: string } = { logPath };
    if (opts.machine !== undefined) replayOptions.machine = opts.machine;
    const result = await runReplay(defaultReplayDeps, replayOptions);
    process.exit(result.exitCode);
  });
}
