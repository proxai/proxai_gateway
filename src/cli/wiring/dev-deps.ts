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
import { writeConfigToFile } from 'services/config';
import { buildGatewayConfig } from 'cli/commands/setup/build-config.ts';
import { readMachineUuid, deriveHostId } from 'core/system';
import { nowIsoUtc, GATEWAY_USER_AGENT } from 'core/utils';
import { HttpClient } from 'services/http';

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

async function verifyKeySimple(url: string, apiKey: string): Promise<{ success: boolean }> {
  const http = new HttpClient({
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

async function writeDevConfigFull(profileCtx: ProfileContext, apiKey: string): Promise<void> {
  const machineUuid = await readMachineUuid();
  const userId = 'dev';
  const hostId = deriveHostId(machineUuid, userId);
  const config = buildGatewayConfig({
    apiKey,
    userId,
    hostId,
    installedAt: nowIsoUtc(),
    installSource: 'github_release',
    bufferDbPath: profileCtx.bufferDbPath,
    logDir: profileCtx.logDir,
    defaultNestBaseUrl: profileCtx.defaultNestBaseUrl,
  });
  await writeConfigToFile(config, profileCtx.configFilePath);
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
    registerDevServiceUnit: async () => {
      if (devServiceUnitPath === null) return;
      await writeServiceUnit({
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
