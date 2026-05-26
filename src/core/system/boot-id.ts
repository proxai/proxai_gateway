import { GatewayError } from 'core/utils';

export interface BootIdSpawnResult {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  exitCode: number | null;
}

export type BootIdSpawnFn = (
  argv: string[],
  options: { stdout: 'pipe'; stderr: 'pipe' },
) => BootIdSpawnResult;

export interface BootIdFileReader {
  exists: () => Promise<boolean>;
  text: () => Promise<string>;
}

export interface BootIdDeps {
  platform?: NodeJS.Platform;
  spawn?: BootIdSpawnFn;
  readFile?: (path: string) => BootIdFileReader;
}

const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

export async function readBootId(deps: BootIdDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultBootIdSpawn();
  const readFile = deps.readFile ?? defaultBootIdReadFile;

  if (platform === 'darwin') {
    return readDarwin(spawn);
  }
  if (platform === 'linux') {
    return readLinux(readFile);
  }
  if (platform === 'win32') {
    return readWin32(spawn);
  }
  throw new GatewayError('fatal', `unable to read boot id for platform ${platform}`);
}

async function readDarwin(spawn: BootIdSpawnFn): Promise<string> {
  const proc = spawn(['sysctl', '-n', 'kern.boottime'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new GatewayError(
      'fatal',
      `unable to read boot id for platform darwin (sysctl exit ${exitCode.toString()})`,
    );
  }

  const match = /sec\s*=\s*(\d+)/.exec(stdout);
  if (match === null || match[1] === undefined) {
    throw new GatewayError('fatal', 'unable to read boot id for platform darwin');
  }
  return sha256Hex(`darwin:${match[1]}`);
}

async function readLinux(readFile: (path: string) => BootIdFileReader): Promise<string> {
  const handle = readFile(LINUX_BOOT_ID_PATH);
  if (!(await handle.exists())) {
    throw new GatewayError('fatal', 'unable to read boot id for platform linux');
  }
  const value = (await handle.text()).trim();
  if (value.length === 0) {
    throw new GatewayError('fatal', 'unable to read boot id for platform linux');
  }
  return value;
}

async function readWin32(spawn: BootIdSpawnFn): Promise<string> {
  const proc = spawn(
    [
      'powershell',
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new GatewayError(
      'fatal',
      `unable to read boot id for platform win32 (powershell exit ${exitCode.toString()})`,
    );
  }
  const trimmed = stdout.trim();
  const match = /^\d+$/.exec(trimmed);
  if (match === null) {
    throw new GatewayError('fatal', 'unable to read boot id for platform win32');
  }
  return sha256Hex(`win32:${trimmed}`);
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function defaultBootIdSpawn(): BootIdSpawnFn {
  return (argv, options) => {
    const proc: unknown = Bun.spawn(argv, options);
    return proc as BootIdSpawnResult;
  };
}

export function defaultBootIdReadFile(path: string): BootIdFileReader {
  const file = Bun.file(path);
  return {
    exists: () => file.exists(),
    text: () => file.text(),
  };
}
