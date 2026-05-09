import { WINDOWS_TASK_NAME } from 'cli/cli.constants.ts';
import { runCommand } from 'cli/service-manager/run-command.ts';
import type { ServiceManager, ServiceRuntimeInfo, SpawnFn } from 'cli/service-manager/types.ts';

export function createSchtasksManager(spawn: SpawnFn, unitPath: string): ServiceManager {
  const taskName = WINDOWS_TASK_NAME;
  return {
    isRegistered: async () => {
      const result = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      return result.exitCode === 0;
    },
    isRunning: async () => {
      const result = await runCommand(spawn, [
        'schtasks',
        '/Query',
        '/TN',
        taskName,
        '/FO',
        'LIST',
      ]);
      if (result.exitCode !== 0) return false;
      return /^Status:\s*Running\s*$/im.test(result.stdout);
    },
    ensureRegistered: async () => {
      const query = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      if (query.exitCode === 0) return;
      const create = await runCommand(spawn, [
        'schtasks',
        '/Create',
        '/TN',
        taskName,
        '/XML',
        unitPath,
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
    start: async () => {
      const query = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      if (query.exitCode !== 0) {
        const create = await runCommand(spawn, [
          'schtasks',
          '/Create',
          '/TN',
          taskName,
          '/XML',
          unitPath,
          '/F',
        ]);
        if (create.exitCode !== 0) {
          throw new Error(
            `schtasks /Create failed (exit ${create.exitCode.toString()}): ${
              create.stderr.trim() || create.stdout.trim()
            }`,
          );
        }
      }
      const run = await runCommand(spawn, ['schtasks', '/Run', '/TN', taskName]);
      if (run.exitCode !== 0) {
        throw new Error(
          `schtasks /Run failed (exit ${run.exitCode.toString()}): ${
            run.stderr.trim() || run.stdout.trim()
          }`,
        );
      }
    },
    stop: async () => {
      await runCommand(spawn, ['schtasks', '/End', '/TN', taskName]);
    },
    restart: async () => {
      const query = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      if (query.exitCode !== 0) {
        const create = await runCommand(spawn, [
          'schtasks',
          '/Create',
          '/TN',
          taskName,
          '/XML',
          unitPath,
          '/F',
        ]);
        if (create.exitCode !== 0) {
          throw new Error(
            `schtasks /Create failed (exit ${create.exitCode.toString()}): ${
              create.stderr.trim() || create.stdout.trim()
            }`,
          );
        }
      }

      await runCommand(spawn, ['schtasks', '/End', '/TN', taskName]);
      const run = await runCommand(spawn, ['schtasks', '/Run', '/TN', taskName]);
      if (run.exitCode !== 0) {
        throw new Error(
          `schtasks /Run failed (exit ${run.exitCode.toString()}): ${
            run.stderr.trim() || run.stdout.trim()
          }`,
        );
      }
    },
    unregister: async () => {
      const query = await runCommand(spawn, ['schtasks', '/Query', '/TN', taskName]);
      if (query.exitCode !== 0) return;
      await runCommand(spawn, ['schtasks', '/Delete', '/TN', taskName, '/F']);
    },
    runtimeInfo: async () => {
      const result = await runCommand(spawn, [
        'schtasks',
        '/Query',
        '/TN',
        taskName,
        '/FO',
        'LIST',
        '/V',
      ]);
      if (result.exitCode !== 0) return { pid: null, startedAt: null };
      return parseSchtasksQuery(result.stdout);
    },
  };
}

export function parseSchtasksQuery(stdout: string): ServiceRuntimeInfo {
  const startMatch = /^Start Time:\s*(.+)$/im.exec(stdout);
  const dateMatch = /^Start Date:\s*(.+)$/im.exec(stdout);
  let startedAt: Date | null = null;
  if (
    startMatch !== null &&
    startMatch[1] !== undefined &&
    dateMatch !== null &&
    dateMatch[1] !== undefined
  ) {
    const combined = `${dateMatch[1].trim()} ${startMatch[1].trim()}`;
    const ms = Date.parse(combined);
    if (Number.isFinite(ms)) startedAt = new Date(ms);
  }
  return { pid: null, startedAt };
}
