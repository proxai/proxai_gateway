import type { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { StatusCommandDeps, StatusCommandOptions } from 'cli/commands/status';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';
import { PACKAGE_VERSION } from 'core/utils';
import { openReadOnlyBufferDb } from 'services/buffer';
import { loadConfigFromFile } from 'services/config';

const STATUS_BINARY_PATH = process.execPath;

export interface StatusContext {
  deps: StatusCommandDeps;
  options: StatusCommandOptions;
  cleanup: () => void;
}

export interface BuildStatusContextInputs {
  profileCtx: ProfileContext;
  configPath?: string;
  defaultBufferPath?: string;
  configOverride?: string;
  json: boolean;
  serviceManager: ServiceManager | null;
}

export async function buildStatusContext(inputs: BuildStatusContextInputs): Promise<StatusContext> {
  const { profileCtx } = inputs;
  const options: StatusCommandOptions = { profileName: profileCtx.name };
  if (inputs.json) options.json = true;

  const cfgPath = inputs.configPath ?? profileCtx.configFilePath;
  const exists = await Bun.file(cfgPath).exists();

  if (!exists) {
    const deps: StatusCommandDeps = {
      output: consoleOutput(),
      configPath: cfgPath,
      configExists: () => Promise.resolve(false),
      bufferFullSentinelPath: profileCtx.sentinels.bufferFull,
      authFailedSentinelPath: profileCtx.sentinels.authFailed,
      sessionStoppedSentinelPath: profileCtx.sentinels.sessionStopped,
      updateAvailableSentinelPath: profileCtx.sentinels.updateAvailable,
      devModeSentinelPath: join(profileRootDir(), 'DEV_MODE'),
      binaryPath: STATUS_BINARY_PATH,
    };
    return { deps, options, cleanup: () => {} };
  }

  let bufferPath = inputs.defaultBufferPath ?? profileCtx.bufferDbPath;
  try {
    const config = await loadConfigFromFile(inputs.configOverride ?? profileCtx.configFilePath);
    bufferPath = config.capture.bufferPath;
  } catch {}

  let buffer: Database | undefined;
  try {
    buffer = openReadOnlyBufferDb(bufferPath);
  } catch {}

  const deps: StatusCommandDeps = {
    output: consoleOutput(),
    ...(buffer !== undefined ? { buffer } : {}),
    configPath: cfgPath,
    configExists: () => Promise.resolve(true),
    bufferFullSentinelPath: profileCtx.sentinels.bufferFull,
    authFailedSentinelPath: profileCtx.sentinels.authFailed,
    sessionStoppedSentinelPath: profileCtx.sentinels.sessionStopped,
    updateAvailableSentinelPath: profileCtx.sentinels.updateAvailable,
    devModeSentinelPath: join(profileRootDir(), 'DEV_MODE'),
    currentVersion: PACKAGE_VERSION,
    binaryPath: STATUS_BINARY_PATH,
    loadConfig: (path) => loadConfigFromFile(path ?? profileCtx.configFilePath),
  };
  if (inputs.serviceManager !== null) {
    deps.serviceManager = inputs.serviceManager;
  }
  return {
    deps,
    options,
    cleanup: () => {
      if (buffer !== undefined) {
        buffer.close();
      }
    },
  };
}
