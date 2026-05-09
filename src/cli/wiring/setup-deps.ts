import type { CommandResult } from 'cli/cli.types.ts';
import { runSetup } from 'cli/commands/setup.ts';
import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup.ts';
import { resolveWindowsUserId } from 'cli/wiring/platform.ts';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import {
  authFailedSentinelPath,
  bufferDbPath,
  configFilePath,
  logDir,
  sessionStoppedSentinelPath,
} from 'core/io/fs';
import { readMachineUuid } from 'core/system';
import { GATEWAY_USER_AGENT } from 'core/utils';
import {
  NEST_INGEST_URL,
  NEST_REGISTER_HOST_ID_URL,
  NEST_VERIFY_KEY_URL,
  NEST_WATERMARKS_URL,
} from 'services/config';
import type { InstallSource } from 'services/config';
import { HttpClient } from 'services/http';

export interface BuildSetupDepsInputs {
  platform: NodeJS.Platform;
  programPath: string;
  serviceUnitPath: string | null;
  serviceManager: ServiceManager | null;
  env: NodeJS.ProcessEnv;
}

export function buildSetupDeps(inputs: BuildSetupDepsInputs): SetupCommandDeps {
  const out = consoleOutput();
  const base: SetupCommandDeps = {
    output: out,
    prompts: inquirerPrompts(),
    configPath: configFilePath(),
    bufferDbPath: bufferDbPath(),
    logDir: logDir(),
    authFailedSentinelPath: authFailedSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    serviceUnitPath: inputs.serviceUnitPath,
    programPath: inputs.programPath,
    configExists: () => Bun.file(configFilePath()).exists(),
    httpClientFactory: (apiKey, hostId) =>
      new HttpClient({
        apiKey,
        hostId,
        endpoints: {
          ingest: NEST_INGEST_URL,
          verifyKey: NEST_VERIFY_KEY_URL,
          watermarks: NEST_WATERMARKS_URL,
          registerHostId: NEST_REGISTER_HOST_ID_URL,
        },
        gatewayVersion: GATEWAY_USER_AGENT,
      }),
    readMachineUuid: () => readMachineUuid(),
    platform: inputs.platform,
  };
  if (inputs.serviceManager !== null) {
    base.serviceManager = inputs.serviceManager;
  }
  if (inputs.platform === 'win32') {
    const userId = resolveWindowsUserId(inputs.env);
    if (userId !== undefined) {
      base.windowsUserId = userId;
    } else {
      out.warn(
        'could not detect Windows user id (USERDOMAIN/USERNAME unset); using INTERACTIVE placeholder',
      );
    }
  }
  return base;
}

const VALID_INSTALL_SOURCES = [
  'bun',
  'pnpm',
  'yarn',
  'npm',
  'brew',
  'github_release',
] as const satisfies readonly InstallSource[];

export function buildSetupOptions(opts: {
  apiKey?: string;
  installSource: string;
  start?: boolean;
  force?: boolean;
}): SetupCommandOptions {
  const installSource: InstallSource = (VALID_INSTALL_SOURCES as readonly string[]).includes(
    opts.installSource,
  )
    ? (opts.installSource as InstallSource)
    : 'github_release';
  const out: SetupCommandOptions = { installSource };
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  if (opts.start === false) out.noStart = true;
  if (opts.force === true) out.force = true;
  return out;
}

export interface InvokeSetupInteractiveInputs extends BuildSetupDepsInputs {}

export type RunSetupFn = typeof runSetup;

export function invokeSetupInteractive(
  inputs: InvokeSetupInteractiveInputs,
  runner: RunSetupFn = runSetup,
): () => Promise<CommandResult> {
  return () => runner(buildSetupDeps(inputs), {} as SetupCommandOptions);
}
