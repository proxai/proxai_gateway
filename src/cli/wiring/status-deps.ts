import type { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { StatusCommandDeps, StatusCommandOptions } from 'cli/commands/status';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import {
  authFailedSentinelPath,
  bufferDbPath,
  bufferFullSentinelPath,
  configFilePath,
  sessionStoppedSentinelPath,
  updateAvailableSentinelPath,
} from 'core/io/fs';
import { profileRootDir } from 'core/io/fs/profile.ts';
import { PACKAGE_VERSION } from 'core/utils';

const STATUS_BINARY_PATH = process.execPath;
import { openBufferDb } from 'services/buffer';
import { loadConfigFromFile } from 'services/config';

export interface StatusContext {
  deps: StatusCommandDeps;
  options: StatusCommandOptions;
  cleanup: () => void;
}

export interface BuildStatusContextInputs {
  configPath?: string;
  defaultBufferPath?: string;
  configOverride?: string;
  json: boolean;
  serviceManager: ServiceManager | null;
}

export async function buildStatusContext(inputs: BuildStatusContextInputs): Promise<StatusContext> {
  const options: StatusCommandOptions = {};
  if (inputs.json) options.json = true;

  const cfgPath = inputs.configPath ?? configFilePath();
  const exists = await Bun.file(cfgPath).exists();

  if (!exists) {
    const deps: StatusCommandDeps = {
      output: consoleOutput(),
      configPath: cfgPath,
      configExists: () => Promise.resolve(false),
      bufferFullSentinelPath: bufferFullSentinelPath(),
      authFailedSentinelPath: authFailedSentinelPath(),
      sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
      updateAvailableSentinelPath: updateAvailableSentinelPath(),
      devModeSentinelPath: join(profileRootDir(), 'DEV_MODE'),
      binaryPath: STATUS_BINARY_PATH,
    };
    return { deps, options, cleanup: () => {} };
  }

  let bufferPath = inputs.defaultBufferPath ?? bufferDbPath();
  try {
    const config = await loadConfigFromFile(inputs.configOverride);
    bufferPath = config.capture.bufferPath;
  } catch {}

  const buffer: Database = openBufferDb(bufferPath);
  const deps: StatusCommandDeps = {
    output: consoleOutput(),
    buffer,
    configPath: cfgPath,
    configExists: () => Promise.resolve(true),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    authFailedSentinelPath: authFailedSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    updateAvailableSentinelPath: updateAvailableSentinelPath(),
    devModeSentinelPath: join(profileRootDir(), 'DEV_MODE'),
    currentVersion: PACKAGE_VERSION,
    binaryPath: STATUS_BINARY_PATH,
    loadConfig: (path) => loadConfigFromFile(path),
  };
  if (inputs.serviceManager !== null) {
    deps.serviceManager = inputs.serviceManager;
  }
  return { deps, options, cleanup: () => buffer.close() };
}
