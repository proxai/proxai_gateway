import type { SpawnFn } from 'cli/service-manager/types.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';

export interface WatchdogManager {
  isInstalled(): Promise<boolean>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
}

export interface WatchdogManagerDeps {
  platform: NodeJS.Platform;
  profile: ProfileName;
  spawn?: SpawnFn;
  label?: string;
  plistPath?: string;
  timerName?: string;
  timerPath?: string;
  serviceName?: string;
  servicePath?: string;
  taskName?: string;
  xmlPath?: string;
}
