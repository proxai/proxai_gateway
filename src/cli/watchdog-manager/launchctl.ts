import { runCommand } from 'cli/service-manager/run-command.ts';
import type { SpawnFn } from 'cli/service-manager/types.ts';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';

function uidString(): string {
  return String(process.getuid?.() ?? 0);
}

function darwinTarget(label: string): string {
  return `gui/${uidString()}/${label}`;
}

function darwinDomain(): string {
  return `gui/${uidString()}`;
}

export function createWatchdogLaunchctlManager(
  spawn: SpawnFn,
  plistPath: string,
  label: string,
): WatchdogManager {
  return {
    isInstalled: async () => {
      const result = await runCommand(spawn, ['launchctl', 'print', darwinTarget(label)]);
      return result.exitCode === 0;
    },
    install: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget(label)]);
      if (printed.exitCode === 0) {
        return;
      }
      const bootstrap = await runCommand(spawn, [
        'launchctl',
        'bootstrap',
        darwinDomain(),
        plistPath,
      ]);
      if (bootstrap.exitCode !== 0) {
        throw new Error(
          `launchctl bootstrap failed (exit ${bootstrap.exitCode.toString()}): ${
            bootstrap.stderr.trim() || bootstrap.stdout.trim()
          }`,
        );
      }
    },
    uninstall: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget(label)]);
      if (printed.exitCode !== 0) {
        return;
      }
      const out = await runCommand(spawn, ['launchctl', 'bootout', darwinTarget(label)]);
      if (out.exitCode !== 0) {
        throw new Error(
          `launchctl bootout failed (exit ${out.exitCode.toString()}): ${
            out.stderr.trim() || out.stdout.trim()
          }`,
        );
      }
    },
  };
}
