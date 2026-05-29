import type { DoctorCommandDeps } from 'cli/commands/doctor/doctor.types.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { nestVerifyKeyUrl } from 'services/config';
import { PACKAGE_VERSION } from 'core/utils';

export interface BuildDoctorDepsInputs {
  serviceManager: ServiceManager | null;
  platform?: NodeJS.Platform;
  profileCtx: ProfileContext;
}

export function buildDoctorDeps(inputs: BuildDoctorDepsInputs): DoctorCommandDeps {
  const { profileCtx } = inputs;
  return {
    output: consoleOutput(),
    bufferDbPath: profileCtx.bufferDbPath,
    configFilePath: profileCtx.configFilePath,
    configDirPath: profileCtx.configDir,
    logDirPath: profileCtx.logDir,
    authFailedSentinelPath: profileCtx.sentinels.authFailed,
    bufferFullSentinelPath: profileCtx.sentinels.bufferFull,
    sessionStoppedSentinelPath: profileCtx.sentinels.sessionStopped,
    updateAvailableSentinelPath: profileCtx.sentinels.updateAvailable,
    nestVerifyKeyUrl: nestVerifyKeyUrl(profileCtx.defaultNestBaseUrl),
    serviceManager: inputs.serviceManager,
    platform: inputs.platform ?? process.platform,
    binaryPath: process.execPath,
    currentVersion: PACKAGE_VERSION,
    profileCtx,
  };
}
