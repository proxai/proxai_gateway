import { runCommand } from 'cli/service-manager/run-command.ts';
import type { SpawnFn } from 'cli/service-manager/types.ts';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';

export function createWatchdogSchtasksManager(
  spawn: SpawnFn,
  xmlPath: string,
  taskName: string,
): WatchdogManager {
  return {
    isInstalled: async () => {
      const result = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      return result.exitCode === 0;
    },
    install: async () => {
      const create = await runCommand(spawn, [
        'schtasks',
        '/Create',
        '/TN',
        taskName,
        '/XML',
        xmlPath,
        '/F',
      ]);
      if (create.exitCode !== 0) {
        throw new Error(
          `schtasks /Create failed (exit ${create.exitCode.toString()}): ${
            create.stderr.trim() || create.stdout.trim()
          }`,
        );
      }
    },
    uninstall: async () => {
      const query = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      if (query.exitCode !== 0) {
        return;
      }
      await runCommand(spawn, ['schtasks', '/Delete', '/TN', taskName, '/F']);
    },
  };
}
