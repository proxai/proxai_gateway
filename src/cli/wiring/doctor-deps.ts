import type { DoctorCommandDeps } from 'cli/commands/doctor/doctor.types.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import {
  authFailedSentinelPath,
  bufferDbPath,
  bufferFullSentinelPath,
  configDir,
  configFilePath,
  logDir,
  sessionStoppedSentinelPath,
  updateAvailableSentinelPath,
} from 'core/io/fs';
import { NEST_VERIFY_KEY_URL } from 'services/config';
import { PACKAGE_VERSION } from 'core/utils';

export interface BuildDoctorDepsInputs {
  serviceManager: ServiceManager | null;
  platform?: NodeJS.Platform;
}

export function buildDoctorDeps(inputs: BuildDoctorDepsInputs): DoctorCommandDeps {
  return {
    output: consoleOutput(),
    bufferDbPath: bufferDbPath(),
    configFilePath: configFilePath(),
    configDirPath: configDir(),
    logDirPath: logDir(),
    authFailedSentinelPath: authFailedSentinelPath(),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    updateAvailableSentinelPath: updateAvailableSentinelPath(),
    nestVerifyKeyUrl: NEST_VERIFY_KEY_URL,
    serviceManager: inputs.serviceManager,
    platform: inputs.platform ?? process.platform,
    binaryPath: process.execPath,
    currentVersion: PACKAGE_VERSION,
  };
}
