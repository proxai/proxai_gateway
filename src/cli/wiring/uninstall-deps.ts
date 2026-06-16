import { join } from 'node:path';
import { homedir } from 'node:os';

import { createDefaultBinaryRemover } from 'services/uninstall';
import { createDefaultShellPathCleaner } from 'services/uninstall';
import type { UninstallCommandDeps, UninstallCommandOptions } from 'cli/commands/uninstall';
import { createDefaultSweep } from 'services/uninstall';
import { consoleOutput } from 'cli/output.ts';
import { inquirerPrompts } from 'cli/prompts.ts';
import { getServiceManager } from 'cli/service-manager';
import type { ServiceManager } from 'cli/service-manager';
import { devLaunchdLabel, devSystemdUnitName } from 'cli/service-unit/dev-labels.ts';
import { defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';
import { defaultSystemdUnitPath } from 'cli/service-unit/systemd-unit.ts';
import { defaultScheduledTaskXmlPath } from 'cli/service-unit/scheduled-task-xml.ts';
import { buildProfileContext, profileRootDir, profileLogDirRoot } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

function buildDevServiceUnitPath(platform: NodeJS.Platform, devConfigDir: string): string | null {
  if (platform === 'darwin') return defaultLaunchdPlistPath(devLaunchdLabel());
  if (platform === 'linux') return defaultSystemdUnitPath(devSystemdUnitName());
  if (platform === 'win32') return defaultScheduledTaskXmlPath(devConfigDir);
  return null;
}

function buildDevServiceManager(
  platform: NodeJS.Platform,
  devConfigDir: string,
): ServiceManager | null {
  const unitPath = buildDevServiceUnitPath(platform, devConfigDir);
  if (unitPath === null) return null;
  return getServiceManager({ platform, unitPath, profile: 'dev' });
}

import { buildWatchdogServiceContext } from 'cli/wiring/platform.ts';

export interface BuildUninstallDepsInputs {
  platform: NodeJS.Platform;
  programPath: string;
  serviceUnitPath: string;
  serviceManager: ServiceManager;
  profileCtx: ProfileContext;
}

export function buildUninstallDeps(inputs: BuildUninstallDepsInputs): UninstallCommandDeps {
  const { profileCtx } = inputs;
  const devCtx = buildProfileContext('dev');
  const devServiceManager = profileCtx.isDev
    ? null
    : buildDevServiceManager(inputs.platform, devCtx.configDir);
  const devServiceUnitPath = profileCtx.isDev
    ? null
    : buildDevServiceUnitPath(inputs.platform, devCtx.configDir);
  const watchdogCtx = buildWatchdogServiceContext(inputs.platform, inputs.programPath, profileCtx);
  const devWatchdogCtx = profileCtx.isDev
    ? null
    : buildWatchdogServiceContext(inputs.platform, inputs.programPath, devCtx);

  return {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    configPath: profileCtx.configFilePath,
    configDir: profileCtx.configDir,
    logDir: profileCtx.logDir,
    serviceUnitPath: inputs.serviceUnitPath,
    serviceManager: inputs.serviceManager,
    devServiceManager,
    devServiceUnitPath,
    devConfigDir: devCtx.configDir,
    devLogDir: devCtx.logDir,
    profileRootDir: profileRootDir(),
    profileLogDirRoot: profileLogDirRoot(),
    configExists: () => Bun.file(profileCtx.configFilePath).exists(),
    sweep: createDefaultSweep(),
    binaryRemover: createDefaultBinaryRemover(inputs.platform),
    pathCleaner: createDefaultShellPathCleaner(inputs.platform),
    installDir:
      inputs.platform === 'win32'
        ? join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'proxai', 'bin')
        : join(homedir(), '.proxai', 'bin'),
    currentExecPath: inputs.programPath,
    watchdogManager: watchdogCtx?.watchdogManager,
    watchdogUnitPaths: watchdogCtx?.watchdogUnitPaths,
    devWatchdogManager: devWatchdogCtx?.watchdogManager,
    devWatchdogUnitPaths: devWatchdogCtx?.watchdogUnitPaths,
  };
}

export function buildUninstallOptions(opts: {
  reset?: boolean;
  yes?: boolean;
}): UninstallCommandOptions {
  const out: UninstallCommandOptions = {};
  if (opts.reset === true) out.reset = true;
  if (opts.yes === true) out.yes = true;
  return out;
}
