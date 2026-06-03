import type { CommandResult } from 'cli/cli.types.ts';
import { runSetup } from 'cli/commands/setup';
import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup';
import { buildDevServiceManager, buildDevServiceUnitPath } from 'cli/wiring/dev-deps.ts';
import { buildPlatformServiceContext, resolveWindowsUserId } from 'cli/wiring/platform.ts';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { readMachineUuid } from 'core/system';
import { GATEWAY_USER_AGENT } from 'core/utils';
import {
  inferInstallSource,
  nestIngestUrl,
  nestRegisterHostIdUrl,
  nestVerifyKeyUrl,
  nestWatermarksUrl,
} from 'services/config';
import type { InstallSource } from 'services/config';
import { derivedUploadStats, openReadOnlyBufferDb } from 'services/buffer';
import { HttpClient } from 'services/http';

export interface BuildSetupDepsInputs {
  platform: NodeJS.Platform;
  programPath: string;
  serviceUnitPath: string | null;
  serviceManager: ServiceManager | null;
  env: NodeJS.ProcessEnv;
  profileCtx: ProfileContext;
}

export interface SetupServiceContext {
  serviceUnitPath: string | null;
  serviceManager: ServiceManager | null;
}

export function resolveSetupServiceContext(
  platform: NodeJS.Platform,
  programPath: string,
  profileCtx: ProfileContext,
): SetupServiceContext {
  if (profileCtx.isDev) {
    return {
      serviceUnitPath: buildDevServiceUnitPath(platform, profileCtx.configDir),
      serviceManager: buildDevServiceManager(platform, profileCtx.configDir),
    };
  }
  const ctx = buildPlatformServiceContext(platform, programPath);
  return {
    serviceUnitPath: ctx?.unitPath ?? null,
    serviceManager: ctx?.serviceManager ?? null,
  };
}

export function buildSetupDeps(inputs: BuildSetupDepsInputs): SetupCommandDeps {
  const out = consoleOutput();
  const { profileCtx } = inputs;
  const base: SetupCommandDeps = {
    output: out,
    prompts: inquirerPrompts(),
    configPath: profileCtx.configFilePath,
    bufferDbPath: profileCtx.bufferDbPath,
    logDir: profileCtx.logDir,
    defaultNestBaseUrl: profileCtx.defaultNestBaseUrl,
    authFailedSentinelPath: profileCtx.sentinels.authFailed,
    sessionStoppedSentinelPath: profileCtx.sentinels.sessionStopped,
    consentSentinelPath: profileCtx.sentinels.consent,
    serviceUnitPath: inputs.serviceUnitPath,
    programPath: inputs.programPath,
    configExists: () => Bun.file(profileCtx.configFilePath).exists(),
    httpClientFactory: (apiKey, hostId) =>
      new HttpClient({
        apiKey,
        hostId,
        endpoints: {
          ingest: nestIngestUrl(profileCtx.defaultNestBaseUrl),
          verifyKey: nestVerifyKeyUrl(profileCtx.defaultNestBaseUrl),
          watermarks: nestWatermarksUrl(profileCtx.defaultNestBaseUrl),
          registerHostId: nestRegisterHostIdUrl(profileCtx.defaultNestBaseUrl),
        },
        gatewayVersion: GATEWAY_USER_AGENT,
      }),
    readMachineUuid: () => readMachineUuid(),
    readLastSuccessAt: async () => {
      try {
        if (!(await Bun.file(profileCtx.bufferDbPath).exists())) return null;
        const db = openReadOnlyBufferDb(profileCtx.bufferDbPath);
        try {
          return derivedUploadStats(db).lastSuccessAt;
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    },
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
}): SetupCommandOptions {
  const installSource: InstallSource = (VALID_INSTALL_SOURCES as readonly string[]).includes(
    opts.installSource,
  )
    ? (opts.installSource as InstallSource)
    : 'github_release';
  const out: SetupCommandOptions = { installSource };
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  if (opts.start === false) out.noStart = true;
  return out;
}

export interface InvokeSetupInteractiveInputs extends BuildSetupDepsInputs {}

export type RunSetupFn = typeof runSetup;

export function invokeSetupInteractive(
  inputs: InvokeSetupInteractiveInputs,
  runner: RunSetupFn = runSetup,
): () => Promise<CommandResult> {
  return () => {
    const installSource = inferInstallSource(inputs.programPath, inputs.platform);
    const options: SetupCommandOptions = { installSource };
    return runner(buildSetupDeps(inputs), options);
  };
}
