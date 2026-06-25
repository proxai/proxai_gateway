import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runExclude } from 'cli/commands/exclude';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { parseProfileName, withProfileOption } from 'cli/program/context.ts';
import { loadConfigFromFile, writeConfigToFile } from 'services/config';
import type { GatewayConfig } from 'services/config';

function buildExcludeDeps(profileName: string | undefined, isDevMode: boolean) {
  const profileCtx = buildProfileContext(parseProfileName(profileName, isDevMode));
  return {
    loadConfig: () =>
      loadConfigFromFile(profileCtx.configFilePath, {
        defaultBufferPath: profileCtx.bufferDbPath,
        defaultLogDir: profileCtx.logDir,
      }),
    writeConfig: (c: GatewayConfig) => writeConfigToFile(c, profileCtx.configFilePath),
    print: (line: string) => console.log(line),
  };
}

export function registerExclusionCommands(program: Command, ctx: CLIContext): void {
  withProfileOption(
    program
      .command('exclude [path]')
      .description(
        'Exclude a project folder from capture (its chats are paused; they backfill if you remove the exclusion later). With no path, or with --list, prints the current exclusions.',
      )
      .option('--list', 'list the current excluded projects', false),
    ctx.isDevMode,
  ).action(async (path: string | undefined, opts: { list?: boolean; profile?: string }) => {
    const action =
      opts.list === true || path === undefined
        ? ({ kind: 'list' } as const)
        : ({ kind: 'add', path } as const);
    const result = await runExclude(buildExcludeDeps(opts.profile, ctx.isDevMode), action);
    process.exit(result.exitCode);
  });

  withProfileOption(
    program
      .command('unexclude <path>')
      .description(
        'Remove a project folder from the exclusion list; its chats backfill on the next capture cycle.',
      ),
    ctx.isDevMode,
  ).action(async (path: string, opts: { profile?: string }) => {
    const result = await runExclude(buildExcludeDeps(opts.profile, ctx.isDevMode), {
      kind: 'remove',
      path,
    });
    process.exit(result.exitCode);
  });
}
