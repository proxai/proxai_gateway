import { runCommand } from 'cli/service-manager/run-command.ts';
import type { SpawnFn } from 'cli/service-manager/types.ts';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';

export function createWatchdogSystemctlManager(spawn: SpawnFn, timerName: string): WatchdogManager {
  return {
    isInstalled: async () => {
      const result = await runCommand(spawn, ['systemctl', '--user', 'list-unit-files', timerName]);
      if (result.exitCode !== 0) {
        return false;
      }
      return result.stdout.includes(timerName);
    },
    install: async () => {
      const reload = await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
      if (reload.exitCode !== 0) {
        throw new Error(
          `systemctl daemon-reload failed (exit ${reload.exitCode.toString()}): ${
            reload.stderr.trim() || reload.stdout.trim()
          }`,
        );
      }
      const enable = await runCommand(spawn, ['systemctl', '--user', 'enable', '--now', timerName]);
      if (enable.exitCode !== 0) {
        throw new Error(
          `systemctl enable --now failed (exit ${enable.exitCode.toString()}): ${
            enable.stderr.trim() || enable.stdout.trim()
          }`,
        );
      }
    },
    uninstall: async () => {
      await runCommand(spawn, ['systemctl', '--user', 'disable', '--now', timerName]);
      await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
    },
  };
}
