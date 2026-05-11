import { LAUNCHD_LABEL } from 'cli/cli.constants.ts';
import { runCommand } from 'cli/service-manager/run-command.ts';
import type { ServiceManager, ServiceRuntimeInfo, SpawnFn } from 'cli/service-manager/types.ts';

const LAUNCHCTL_TARGET = `gui/{uid}/${LAUNCHD_LABEL}`;

function uidString(): string {
  return String(process.getuid?.() ?? 0);
}

function darwinTarget(): string {
  return LAUNCHCTL_TARGET.replace('{uid}', uidString());
}

function darwinDomain(): string {
  return `gui/${uidString()}`;
}

export function createLaunchctlManager(spawn: SpawnFn, unitPath: string): ServiceManager {
  return {
    isRegistered: async () => {
      const result = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      return result.exitCode === 0;
    },
    isRunning: async () => {
      const result = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (result.exitCode !== 0) return false;
      return /state\s*=\s*running/.test(result.stdout);
    },
    ensureRegistered: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (printed.exitCode === 0) return;
      const bootstrap = await runCommand(spawn, [
        'launchctl',
        'bootstrap',
        darwinDomain(),
        unitPath,
      ]);
      if (bootstrap.exitCode !== 0) {
        throw new Error(
          `launchctl bootstrap failed (exit ${bootstrap.exitCode.toString()}): ${
            bootstrap.stderr.trim() || bootstrap.stdout.trim()
          }`,
        );
      }
    },
    start: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (printed.exitCode !== 0) {
        const bootstrap = await runCommand(spawn, [
          'launchctl',
          'bootstrap',
          darwinDomain(),
          unitPath,
        ]);
        if (bootstrap.exitCode !== 0) {
          throw new Error(
            `launchctl bootstrap failed (exit ${bootstrap.exitCode.toString()}): ${
              bootstrap.stderr.trim() || bootstrap.stdout.trim()
            }`,
          );
        }
      }
      const kick = await runCommand(spawn, ['launchctl', 'kickstart', darwinTarget()]);
      if (kick.exitCode !== 0) {
        throw new Error(
          `launchctl kickstart failed (exit ${kick.exitCode.toString()}): ${
            kick.stderr.trim() || kick.stdout.trim()
          }`,
        );
      }
    },
    stop: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (printed.exitCode !== 0) return;
      const out = await runCommand(spawn, ['launchctl', 'bootout', darwinTarget()]);
      if (out.exitCode !== 0) {
        throw new Error(
          `launchctl bootout failed (exit ${out.exitCode.toString()}): ${
            out.stderr.trim() || out.stdout.trim()
          }`,
        );
      }
    },
    restart: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (printed.exitCode !== 0) {
        const bootstrap = await runCommand(spawn, [
          'launchctl',
          'bootstrap',
          darwinDomain(),
          unitPath,
        ]);
        if (bootstrap.exitCode !== 0) {
          throw new Error(
            `launchctl bootstrap failed (exit ${bootstrap.exitCode.toString()}): ${
              bootstrap.stderr.trim() || bootstrap.stdout.trim()
            }`,
          );
        }
      }
      const kick = await runCommand(spawn, ['launchctl', 'kickstart', '-k', darwinTarget()]);
      if (kick.exitCode !== 0) {
        throw new Error(
          `launchctl kickstart -k failed (exit ${kick.exitCode.toString()}): ${
            kick.stderr.trim() || kick.stdout.trim()
          }`,
        );
      }
    },
    unregister: async () => {
      const printed = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (printed.exitCode !== 0) return;
      const out = await runCommand(spawn, ['launchctl', 'bootout', darwinTarget()]);
      if (out.exitCode !== 0) {
        throw new Error(
          `launchctl bootout failed (exit ${out.exitCode.toString()}): ${
            out.stderr.trim() || out.stdout.trim()
          }`,
        );
      }
    },
    runtimeInfo: async () => {
      const result = await runCommand(spawn, ['launchctl', 'print', darwinTarget()]);
      if (result.exitCode !== 0) return { pid: null, startedAt: null };
      return parseLaunchctlPrint(result.stdout);
    },
  };
}

export function parseLaunchctlPrint(stdout: string): ServiceRuntimeInfo {
  const pidMatch = /\bpid\s*=\s*(\d+)/i.exec(stdout);
  const pid = pidMatch !== null && pidMatch[1] !== undefined ? Number(pidMatch[1]) : null;
  const startedAt = parseLaunchdStartedAt(stdout);
  return { pid, startedAt };
}

function parseLaunchdStartedAt(stdout: string): Date | null {
  const spawnTsMatch = /\bspawn\s*ts\s*=\s*(\d+)/i.exec(stdout);
  const startTimeMatch = /\bstart\s*time\s*=\s*(\d+)/i.exec(stdout);
  const matched = spawnTsMatch ?? startTimeMatch;
  if (matched === null || matched[1] === undefined) return null;
  const epochSeconds = Number(matched[1]);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  return new Date(epochSeconds * 1000);
}
