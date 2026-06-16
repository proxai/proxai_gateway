import { defaultSpawn } from 'cli/service-manager/run-command.ts';
import type { WatchdogManager, WatchdogManagerDeps } from 'cli/watchdog-manager/types.ts';
import { createWatchdogLaunchctlManager } from 'cli/watchdog-manager/launchctl.ts';
import { createWatchdogSystemctlManager } from 'cli/watchdog-manager/systemctl.ts';
import { createWatchdogSchtasksManager } from 'cli/watchdog-manager/schtasks.ts';

function noopWatchdogManager(): WatchdogManager {
  return {
    isInstalled: () => Promise.resolve(false),
    install: () => Promise.resolve(),
    uninstall: () => Promise.resolve(),
  };
}

export function getWatchdogManager(deps: WatchdogManagerDeps): WatchdogManager {
  const testProfileRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];
  if (deps.spawn === undefined && testProfileRoot !== undefined && testProfileRoot.length > 0) {
    return noopWatchdogManager();
  }
  const spawn = deps.spawn ?? defaultSpawn();
  const platform = deps.platform;

  if (platform === 'darwin') {
    return createWatchdogLaunchctlManager(spawn, deps.plistPath ?? '', deps.label ?? '');
  }
  if (platform === 'linux') {
    return createWatchdogSystemctlManager(spawn, deps.timerName ?? '');
  }
  if (platform === 'win32') {
    return createWatchdogSchtasksManager(spawn, deps.xmlPath ?? '', deps.taskName ?? '');
  }
  throw new Error(`unsupported platform for watchdog-manager: ${platform}`);
}

export type { WatchdogManager, WatchdogManagerDeps } from 'cli/watchdog-manager/types.ts';
