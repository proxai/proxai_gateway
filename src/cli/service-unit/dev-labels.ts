import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from 'cli/cli.constants.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';

export function devLaunchdLabel(): string {
  return `${LAUNCHD_LABEL}.dev`;
}

export function devSystemdUnitName(): string {
  return SYSTEMD_UNIT_NAME.replace(/\.service$/, '-dev.service');
}

export function devWindowsTaskName(): string {
  return `${WINDOWS_TASK_NAME} (dev)`;
}

export function profileLaunchdLabel(profile: ProfileName): string {
  return profile === 'dev' ? devLaunchdLabel() : LAUNCHD_LABEL;
}

export function profileSystemdUnitName(profile: ProfileName): string {
  return profile === 'dev' ? devSystemdUnitName() : SYSTEMD_UNIT_NAME;
}

export function profileWindowsTaskName(profile: ProfileName): string {
  return profile === 'dev' ? devWindowsTaskName() : WINDOWS_TASK_NAME;
}
