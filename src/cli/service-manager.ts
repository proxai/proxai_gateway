import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from 'cli/cli.constants.ts';

export interface ServiceManager {
  ensureRegistered(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isRegistered(): Promise<boolean>;
  isRunning(): Promise<boolean>;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  argv: string[],
  options: { stdout: 'pipe'; stderr: 'pipe' },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: number | null;
};

export interface ServiceManagerDeps {
  platform: NodeJS.Platform;
  unitPath: string;
  programPath: string;
  spawn?: SpawnFn;
}

export async function runCommand(spawn: SpawnFn, argv: string[]): Promise<CommandRunResult> {
  const proc = spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

function defaultSpawn(): SpawnFn {
  return ((argv, options) => Bun.spawn(argv, options) as unknown as ReturnType<SpawnFn>) as SpawnFn;
}

export function getServiceManager(deps: ServiceManagerDeps): ServiceManager {
  const spawn = deps.spawn ?? defaultSpawn();
  switch (deps.platform) {
    case 'darwin':
      return createLaunchctlManager(spawn, deps.unitPath);
    case 'linux':
      return createSystemctlManager(spawn);
    case 'win32':
      return createSchtasksManager(spawn, deps.unitPath);
    default:
      throw new Error(`unsupported platform for service-manager: ${deps.platform}`);
  }
}

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

function createLaunchctlManager(spawn: SpawnFn, unitPath: string): ServiceManager {
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
  };
}

function createSystemctlManager(spawn: SpawnFn): ServiceManager {
  const unit = SYSTEMD_UNIT_NAME;
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
  };
}

function createSchtasksManager(spawn: SpawnFn, unitPath: string): ServiceManager {
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
  };
}
