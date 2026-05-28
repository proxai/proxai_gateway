import { runCommand } from 'cli/service-manager/run-command.ts';
import type { ServiceManager, ServiceRuntimeInfo, SpawnFn } from 'cli/service-manager/types.ts';

export function createSystemctlManager(spawn: SpawnFn, unitName: string): ServiceManager {
  const unit = unitName;
  return {
    isRegistered: async () => {
      const result = await runCommand(spawn, ['systemctl', '--user', 'list-unit-files', unit]);
      if (result.exitCode !== 0) return false;
      return result.stdout.includes(unit);
    },
    isRunning: async () => {
      const result = await runCommand(spawn, ['systemctl', '--user', 'is-active', unit]);
      return result.exitCode === 0;
    },
    ensureRegistered: async () => {
      const reload = await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
      if (reload.exitCode !== 0) {
        throw new Error(
          `systemctl daemon-reload failed (exit ${reload.exitCode.toString()}): ${
            reload.stderr.trim() || reload.stdout.trim()
          }`,
        );
      }
      const enabled = await runCommand(spawn, ['systemctl', '--user', 'is-enabled', unit]);
      if (enabled.exitCode !== 0) {
        const enable = await runCommand(spawn, ['systemctl', '--user', 'enable', unit]);
        if (enable.exitCode !== 0) {
          throw new Error(
            `systemctl enable failed (exit ${enable.exitCode.toString()}): ${
              enable.stderr.trim() || enable.stdout.trim()
            }`,
          );
        }
      }
    },
    start: async () => {
      const reload = await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
      if (reload.exitCode !== 0) {
        throw new Error(
          `systemctl daemon-reload failed (exit ${reload.exitCode.toString()}): ${
            reload.stderr.trim() || reload.stdout.trim()
          }`,
        );
      }
      const enabled = await runCommand(spawn, ['systemctl', '--user', 'is-enabled', unit]);
      if (enabled.exitCode !== 0) {
        const enable = await runCommand(spawn, ['systemctl', '--user', 'enable', unit]);
        if (enable.exitCode !== 0) {
          throw new Error(
            `systemctl enable failed (exit ${enable.exitCode.toString()}): ${
              enable.stderr.trim() || enable.stdout.trim()
            }`,
          );
        }
      }
      const startResult = await runCommand(spawn, ['systemctl', '--user', 'start', unit]);
      if (startResult.exitCode !== 0) {
        throw new Error(
          `systemctl start failed (exit ${startResult.exitCode.toString()}): ${
            startResult.stderr.trim() || startResult.stdout.trim()
          }`,
        );
      }
    },
    stop: async () => {
      const stopResult = await runCommand(spawn, ['systemctl', '--user', 'stop', unit]);
      if (stopResult.exitCode !== 0) {
        throw new Error(
          `systemctl stop failed (exit ${stopResult.exitCode.toString()}): ${
            stopResult.stderr.trim() || stopResult.stdout.trim()
          }`,
        );
      }
    },
    restart: async () => {
      const reload = await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
      if (reload.exitCode !== 0) {
        throw new Error(
          `systemctl daemon-reload failed (exit ${reload.exitCode.toString()}): ${
            reload.stderr.trim() || reload.stdout.trim()
          }`,
        );
      }
      const enabled = await runCommand(spawn, ['systemctl', '--user', 'is-enabled', unit]);
      if (enabled.exitCode !== 0) {
        const enable = await runCommand(spawn, ['systemctl', '--user', 'enable', unit]);
        if (enable.exitCode !== 0) {
          throw new Error(
            `systemctl enable failed (exit ${enable.exitCode.toString()}): ${
              enable.stderr.trim() || enable.stdout.trim()
            }`,
          );
        }
      }
      const restartResult = await runCommand(spawn, ['systemctl', '--user', 'restart', unit]);
      if (restartResult.exitCode !== 0) {
        throw new Error(
          `systemctl restart failed (exit ${restartResult.exitCode.toString()}): ${
            restartResult.stderr.trim() || restartResult.stdout.trim()
          }`,
        );
      }
    },
    unregister: async () => {
      const enabled = await runCommand(spawn, ['systemctl', '--user', 'is-enabled', unit]);
      if (enabled.exitCode === 0) {
        const disable = await runCommand(spawn, ['systemctl', '--user', 'disable', unit]);
        if (disable.exitCode !== 0) {
          throw new Error(
            `systemctl disable failed (exit ${disable.exitCode.toString()}): ${
              disable.stderr.trim() || disable.stdout.trim()
            }`,
          );
        }
      }
      const reload = await runCommand(spawn, ['systemctl', '--user', 'daemon-reload']);
      if (reload.exitCode !== 0) {
        throw new Error(
          `systemctl daemon-reload failed (exit ${reload.exitCode.toString()}): ${
            reload.stderr.trim() || reload.stdout.trim()
          }`,
        );
      }
    },
    runtimeInfo: async () => {
      const result = await runCommand(spawn, [
        'systemctl',
        '--user',
        'show',
        '-p',
        'MainPID',
        '-p',
        'ActiveEnterTimestamp',
        unit,
      ]);
      if (result.exitCode !== 0) return { pid: null, startedAt: null };
      return parseSystemctlShow(result.stdout);
    },
  };
}

export function parseSystemctlShow(stdout: string): ServiceRuntimeInfo {
  const pidMatch = /^MainPID=(\d+)\s*$/m.exec(stdout);
  let pid: number | null = null;
  if (pidMatch !== null && pidMatch[1] !== undefined) {
    const n = Number(pidMatch[1]);
    pid = n > 0 ? n : null;
  }
  const tsMatch = /^ActiveEnterTimestamp=(.*)$/m.exec(stdout);
  let startedAt: Date | null = null;
  if (tsMatch !== null && tsMatch[1] !== undefined) {
    const trimmed = tsMatch[1].trim();
    if (trimmed.length > 0) {
      const ms = Date.parse(trimmed);
      if (Number.isFinite(ms)) startedAt = new Date(ms);
    }
  }
  return { pid, startedAt };
}
