import { join } from 'node:path';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import {
  profileLaunchdLabel,
  profileSystemdUnitName,
  profileWindowsTaskName,
} from 'cli/service-unit/dev-labels.ts';
import { defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';
import { defaultSystemdUnitPath } from 'cli/service-unit/systemd-unit.ts';

export function watchdogLaunchdLabel(profile: ProfileName): string {
  return `${profileLaunchdLabel(profile)}.watchdog`;
}

export function watchdogSystemdTimerName(profile: ProfileName): string {
  return profileSystemdUnitName(profile).replace(/\.service$/, '-watchdog.timer');
}

export function watchdogSystemdServiceName(profile: ProfileName): string {
  return profileSystemdUnitName(profile).replace(/\.service$/, '-watchdog.service');
}

export function watchdogWindowsTaskName(profile: ProfileName): string {
  return `${profileWindowsTaskName(profile)} Watchdog`;
}

export function watchdogLaunchdPlistPath(profile: ProfileName): string {
  return defaultLaunchdPlistPath(watchdogLaunchdLabel(profile));
}

export function watchdogSystemdTimerPath(profile: ProfileName): string {
  return defaultSystemdUnitPath(watchdogSystemdTimerName(profile));
}

export function watchdogSystemdServicePath(profile: ProfileName): string {
  return defaultSystemdUnitPath(watchdogSystemdServiceName(profile));
}

export function defaultWatchdogScheduledTaskXmlPath(configDir: string): string {
  return join(configDir, 'scheduled-task-watchdog.xml');
}
