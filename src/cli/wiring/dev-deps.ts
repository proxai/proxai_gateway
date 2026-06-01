import { join } from 'node:path';

import type { DevCommandDeps } from 'cli/commands/dev.ts';
import { consoleOutput } from 'cli/output.ts';
import { getServiceManager } from 'cli/service-manager';
import type { ServiceManager } from 'cli/service-manager';
import { defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';
import { devLaunchdLabel, devSystemdUnitName } from 'cli/service-unit/dev-labels.ts';
import { defaultSystemdUnitPath } from 'cli/service-unit/systemd-unit.ts';
import { defaultScheduledTaskXmlPath } from 'cli/service-unit/scheduled-task-xml.ts';
import { writeServiceUnit } from 'cli/service-unit/writer.ts';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import {
  writeConfigToFile,
  nestIngestUrl,
  nestVerifyKeyUrl,
  nestWatermarksUrl,
  nestRegisterHostIdUrl,
} from 'services/config';
import { buildGatewayConfig } from 'cli/commands/setup/build-config.ts';
import { clearAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';
import { readMachineUuid, deriveHostId } from 'core/system';
import { nowIsoUtc, GATEWAY_USER_AGENT } from 'core/utils';
import { HttpClient } from 'services/http';
import type { ServiceManagerDeps } from 'cli/service-manager';
import type { WriteServiceUnitInput } from 'cli/service-unit/writer.ts';
import type { GatewayConfig } from 'services/config';

/** Seam for tests — swap individual deps without mock.module. */
export const __deps = {
  getServiceManager: (deps: ServiceManagerDeps): ServiceManager => getServiceManager(deps),
  createHttpClient: (options: {
    apiKey: string;
    hostId: string;
    endpoints: { ingest: string; verifyKey: string; watermarks: string; registerHostId: string };
    gatewayVersion: string;
  }) => new HttpClient(options),
  writeServiceUnit: (input: WriteServiceUnitInput): Promise<void> => writeServiceUnit(input),
  readMachineUuid: (): Promise<string> => readMachineUuid(),
  deriveHostId: (machineUuid: string, userId: string): string => deriveHostId(machineUuid, userId),
  buildGatewayConfig: (input: {
    apiKey: string;
    userId: string;
    hostId: string;
    installedAt: string;
    installSource: 'github_release';
    bufferDbPath: string;
    logDir: string;
    defaultNestBaseUrl: string;
  }): GatewayConfig => buildGatewayConfig(input),
  writeConfigToFile: (config: GatewayConfig, path: string): Promise<void> =>
    writeConfigToFile(config, path),
  clearAuthFailedSentinel: (path: string): Promise<void> => clearAuthFailedSentinel(path),
  nowIsoUtc: (): string => nowIsoUtc(),
  defaultLaunchdPlistPath: (label: string): string => defaultLaunchdPlistPath(label),
  defaultSystemdUnitPath: (unitName: string): string => defaultSystemdUnitPath(unitName),
  defaultScheduledTaskXmlPath: (configDir: string): string =>
    defaultScheduledTaskXmlPath(configDir),
  devLaunchdLabel: (): string => devLaunchdLabel(),
  devSystemdUnitName: (): string => devSystemdUnitName(),
};

export function buildDevServiceUnitPath(
  platform: NodeJS.Platform,
  devConfigDir: string,
): string | null {
  if (platform === 'darwin') return __deps.defaultLaunchdPlistPath(__deps.devLaunchdLabel());
  if (platform === 'linux') return __deps.defaultSystemdUnitPath(__deps.devSystemdUnitName());
  if (platform === 'win32') return __deps.defaultScheduledTaskXmlPath(devConfigDir);
  return null;
}

export function buildDevServiceManager(
  platform: NodeJS.Platform,
  devConfigDir: string,
): ServiceManager | null {
  const unitPath = buildDevServiceUnitPath(platform, devConfigDir);
  if (unitPath === null) return null;
  return __deps.getServiceManager({ platform, unitPath, profile: 'dev' });
}

export async function verifyKeySimple(url: string, apiKey: string): Promise<{ success: boolean }> {
  const http = __deps.createHttpClient({
    apiKey,
    hostId: '',
    endpoints: {
      ingest: url,
      verifyKey: url,
      watermarks: url,
      registerHostId: url,
    },
    gatewayVersion: GATEWAY_USER_AGENT,
  });
  const result = await http.verifyKey();
  return { success: result.success };
}

export async function writeDevConfigFull(
  profileCtx: ProfileContext,
  apiKey: string,
): Promise<void> {
  const machineUuid = await __deps.readMachineUuid();
  const userId = 'dev';
  const hostId = __deps.deriveHostId(machineUuid, userId);
  const config = __deps.buildGatewayConfig({
    apiKey,
    userId,
    hostId,
    installedAt: __deps.nowIsoUtc(),
    installSource: 'github_release',
    bufferDbPath: profileCtx.bufferDbPath,
    logDir: profileCtx.logDir,
    defaultNestBaseUrl: profileCtx.defaultNestBaseUrl,
  });
  await __deps.writeConfigToFile(config, profileCtx.configFilePath);
}

export async function registerDevHostIdFull(apiKey: string): Promise<{ registered: boolean }> {
  const machineUuid = await __deps.readMachineUuid();
  const hostId = __deps.deriveHostId(machineUuid, 'dev');
  const baseUrl = buildProfileContext('dev').defaultNestBaseUrl;
  const http = __deps.createHttpClient({
    apiKey,
    hostId,
    endpoints: {
      ingest: nestIngestUrl(baseUrl),
      verifyKey: nestVerifyKeyUrl(baseUrl),
      watermarks: nestWatermarksUrl(baseUrl),
      registerHostId: nestRegisterHostIdUrl(baseUrl),
    },
    gatewayVersion: GATEWAY_USER_AGENT,
  });
  const result = await http.registerHostId();
  return { registered: result.registered };
}

export function buildDevDeps(): DevCommandDeps {
  const devCtx = buildProfileContext('dev');
  const devServiceManager = buildDevServiceManager(process.platform, devCtx.configDir);
  const devServiceUnitPath = buildDevServiceUnitPath(process.platform, devCtx.configDir);

  return {
    output: consoleOutput(),
    devModeSentinelPath: join(profileRootDir(), 'DEV_MODE'),
    devCtx,
    devConfigExists: () => Bun.file(devCtx.configFilePath).exists(),
    devServiceManager,
    verifyKey: verifyKeySimple,
    writeDevConfig: writeDevConfigFull,
    registerDevHostId: registerDevHostIdFull,
    clearAuthFailed: () => __deps.clearAuthFailedSentinel(devCtx.sentinels.authFailed),
    registerDevServiceUnit: async () => {
      if (devServiceUnitPath === null) return;
      await __deps.writeServiceUnit({
        serviceUnitPath: devServiceUnitPath,
        programPath: process.execPath,
        platform: process.platform,
        profileName: 'dev',
      });
      if (devServiceManager !== null) {
        await devServiceManager.ensureRegistered();
      }
    },
  };
}
