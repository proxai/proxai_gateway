import { defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';
import { defaultScheduledTaskXmlPath } from 'cli/service-unit/scheduled-task-xml.ts';
import { getServiceManager } from 'cli/service-manager';
import type { ServiceManager } from 'cli/service-manager';
import type { ServiceUnitRecreateConfig } from 'cli/service-unit/writer.ts';
import { defaultSystemdUnitPath } from 'cli/service-unit/systemd-unit.ts';
import { buildDevServiceUnitPath } from 'cli/wiring/dev-deps.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileContext, ProfileName } from 'core/io/fs/profile.types.ts';

export function platformServiceUnitPath(
  platform: NodeJS.Platform,
  configDir?: string,
): string | null {
  if (platform === 'darwin') return defaultLaunchdPlistPath();
  if (platform === 'linux') return defaultSystemdUnitPath();
  if (platform === 'win32')
    return defaultScheduledTaskXmlPath(configDir ?? buildProfileContext('prod').configDir);
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
  _programPath: string,
  configDir?: string,
): PlatformServiceContext | null {
  const unitPath = platformServiceUnitPath(platform, configDir);
  if (unitPath === null) return null;
  const serviceManager = getServiceManager({ platform, unitPath });
  return { platform, unitPath, serviceManager };
}

export function buildProfileServiceContext(
  platform: NodeJS.Platform,
  programPath: string,
  profileCtx: ProfileContext,
): PlatformServiceContext | null {
  if (profileCtx.isDev) {
    const unitPath = buildDevServiceUnitPath(platform, profileCtx.configDir);
    if (unitPath === null) return null;
    const serviceManager = getServiceManager({ platform, unitPath, profile: 'dev' });
    return { platform, unitPath, serviceManager };
  }
  return buildPlatformServiceContext(platform, programPath, profileCtx.configDir);
}

export function buildServiceUnitRecreate(
  platform: NodeJS.Platform,
  unitPath: string,
  programPath: string,
  env: NodeJS.ProcessEnv,
  profileName: ProfileName = 'prod',
): ServiceUnitRecreateConfig {
  const recreate: ServiceUnitRecreateConfig = {
    serviceUnitPath: unitPath,
    programPath,
    platform,
    profileName,
  };
  if (platform === 'win32') {
    const windowsUserId = resolveWindowsUserId(env);
    if (windowsUserId !== undefined) recreate.windowsUserId = windowsUserId;
  }
  return recreate;
}

import {
  watchdogLaunchdLabel,
  watchdogSystemdTimerName,
  watchdogSystemdServiceName,
  watchdogWindowsTaskName,
  watchdogLaunchdPlistPath,
  watchdogSystemdTimerPath,
  watchdogSystemdServicePath,
  defaultWatchdogScheduledTaskXmlPath,
} from 'cli/service-unit/watchdog-labels.ts';
import { getWatchdogManager } from 'cli/watchdog-manager/index.ts';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';

export interface WatchdogServiceContext {
  platform: NodeJS.Platform;
  watchdogUnitPaths: {
    timerPath?: string;
    servicePath?: string;
    plistPath?: string;
    xmlPath?: string;
  };
  watchdogManager: WatchdogManager;
}

export function buildWatchdogServiceContext(
  platform: NodeJS.Platform,
  _programPath: string,
  profileCtx: ProfileContext,
): WatchdogServiceContext | null {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return null;
  }
  const profileName = profileCtx.name;
  const plistPath = watchdogLaunchdPlistPath(profileName);
  const timerPath = watchdogSystemdTimerPath(profileName);
  const servicePath = watchdogSystemdServicePath(profileName);
  const xmlPath = defaultWatchdogScheduledTaskXmlPath(profileCtx.configDir);

  const watchdogManager = getWatchdogManager({
    platform,
    profile: profileName,
    label: watchdogLaunchdLabel(profileName),
    plistPath,
    timerName: watchdogSystemdTimerName(profileName),
    timerPath,
    serviceName: watchdogSystemdServiceName(profileName),
    servicePath,
    taskName: watchdogWindowsTaskName(profileName),
    xmlPath,
  });

  return {
    platform,
    watchdogUnitPaths: {
      plistPath,
      timerPath,
      servicePath,
      xmlPath,
    },
    watchdogManager,
  };
}
