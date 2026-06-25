import { Command } from 'commander';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { VALID_PROFILES } from 'core/io/fs/profile.types.ts';
import { buildSetupDeps, resolveSetupServiceContext } from 'cli/wiring/setup-deps.ts';

export interface CLIContext {
  isDevMode: boolean;
}

export function exitUnsupportedPlatform(commandName: string): never {
  console.error(`unsupported platform for ${commandName}: ${process.platform}`);
  process.exit(EXIT_CODE.error);
}

export function requireDevMode(commandName: string, isDevMode: boolean): void {
  if (isDevMode) return;
  console.error(`error: unknown command '${commandName}'`);
  process.exit(EXIT_CODE.error);
}

export function parseProfileNameInternal(raw: string | undefined): ProfileName {
  const candidate = (raw ?? 'prod').trim();
  if (candidate === 'prod' || candidate === 'dev') return candidate;
  console.error(`invalid --profile value: '${raw}'. Expected one of: ${VALID_PROFILES.join(', ')}`);
  process.exit(EXIT_CODE.error);
}

export function parseProfileName(raw: string | undefined, isDevMode: boolean): ProfileName {
  if ((raw ?? 'prod').trim() === 'dev' && !isDevMode) {
    console.error(`invalid --profile value: 'dev'. Expected one of: prod`);
    process.exit(EXIT_CODE.error);
  }
  return parseProfileNameInternal(raw);
}

export function withProfileOption(command: Command, isDevMode: boolean): Command {
  if (isDevMode) command.option('--profile <name>', 'profile to target (prod | dev)');
  return command;
}

export async function resolveSetupInputs(
  profileOpt: string | undefined,
  isDevMode: boolean,
): Promise<Parameters<typeof buildSetupDeps>[0]> {
  let profileName: ProfileName;
  if (isDevMode && profileOpt === undefined) {
    profileName = await inquirerPrompts().askProfile();
  } else {
    const defaultProfile: ProfileName = isDevMode ? 'dev' : 'prod';
    profileName = parseProfileName(profileOpt ?? defaultProfile, isDevMode);
  }
  const profileCtx = buildProfileContext(profileName);
  const serviceContext = resolveSetupServiceContext(process.platform, process.execPath, profileCtx);
  return {
    platform: process.platform,
    programPath: process.execPath,
    serviceUnitPath: serviceContext.serviceUnitPath,
    serviceManager: serviceContext.serviceManager,
    env: process.env,
    profileCtx,
  };
}
