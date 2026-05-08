import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME } from 'cli/cli.constants.ts';

export interface ServiceRuntimeInfo {
  pid: number | null;
  startedAt: Date | null;
}

export interface ServiceManager {
  ensureRegistered(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  unregister(): Promise<void>;
  isRegistered(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  runtimeInfo(): Promise<ServiceRuntimeInfo>;
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
  return { pid, startedAt: null };
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
