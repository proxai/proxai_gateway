import { defaultLaunchdPlistPath } from 'cli/launchd-plist.ts';
import { defaultScheduledTaskXmlPath } from 'cli/scheduled-task-xml.ts';
import { getServiceManager } from 'cli/service-manager.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit-writer.ts';
import { defaultSystemdUnitPath } from 'cli/systemd-unit.ts';

export function platformServiceUnitPath(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return defaultLaunchdPlistPath();
  if (platform === 'linux') return defaultSystemdUnitPath();
  if (platform === 'win32') return defaultScheduledTaskXmlPath();
  return null;
}

export function resolveWindowsUserId(env: NodeJS.ProcessEnv): string | undefined {
  const domain = env['USERDOMAIN'];
  const user = env['USERNAME'];
  if (domain !== undefined && domain.length > 0 && user !== undefined && user.length > 0) {
    return `${domain}\\${user}`;
  }
  if (user !== undefined && user.length > 0) return user;
  return undefined;
}

export interface PlatformServiceContext {
  platform: NodeJS.Platform;
  unitPath: string;
  serviceManager: ServiceManager;
}

export function buildPlatformServiceContext(
  platform: NodeJS.Platform,
  programPath: string,
): PlatformServiceContext | null {
  const unitPath = platformServiceUnitPath(platform);
  if (unitPath === null) return null;
  const serviceManager = getServiceManager({ platform, unitPath, programPath });
  return { platform, unitPath, serviceManager };
}

export function buildServiceUnitRecreate(
  platform: NodeJS.Platform,
  unitPath: string,
  programPath: string,
  env: NodeJS.ProcessEnv,
): ServiceUnitRecreateConfig {
  const recreate: ServiceUnitRecreateConfig = {
    serviceUnitPath: unitPath,
    programPath,
    platform,
  };
  if (platform === 'win32') {
    const windowsUserId = resolveWindowsUserId(env);
    if (windowsUserId !== undefined) recreate.windowsUserId = windowsUserId;
  }
  return recreate;
}
