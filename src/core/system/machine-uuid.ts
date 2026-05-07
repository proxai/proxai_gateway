import { GatewayError } from 'core/utils';

export interface MachineUuidSpawnResult {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  exitCode: number | null;
}

export type MachineUuidSpawnFn = (
  argv: string[],
  options: { stdout: 'pipe'; stderr: 'pipe' },
) => MachineUuidSpawnResult;

export interface MachineUuidFileReader {
  exists: () => Promise<boolean>;
  text: () => Promise<string>;
}

export interface MachineUuidDeps {
  platform?: NodeJS.Platform;
  spawn?: MachineUuidSpawnFn;
  readFile?: (path: string) => MachineUuidFileReader;
}

const LINUX_MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

export async function readMachineUuid(deps: MachineUuidDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn();
  const readFile = deps.readFile ?? defaultReadFile;

  if (platform === 'darwin') {
    return readDarwin(spawn);
  }
  if (platform === 'linux') {
    return readLinux(readFile);
  }
  if (platform === 'win32') {
    return readWin32(spawn);
  }
  throw new GatewayError('fatal', `unable to read machine UUID for platform ${platform}`);
}

async function readDarwin(spawn: MachineUuidSpawnFn): Promise<string> {
  const proc = spawn(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new GatewayError(
      'fatal',
      `unable to read machine UUID for platform darwin (ioreg exit ${exitCode.toString()})`,
    );
  }
  for (const line of stdout.split('\n')) {
    if (!line.includes('IOPlatformUUID')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const value = line.slice(eq + 1).trim();
    const stripped = stripQuotes(value);
    if (stripped.length > 0) return stripped;
  }
  throw new GatewayError('fatal', 'unable to read machine UUID for platform darwin');
}

async function readLinux(readFile: (path: string) => MachineUuidFileReader): Promise<string> {
  for (const path of LINUX_MACHINE_ID_PATHS) {
    const handle = readFile(path);
    if (!(await handle.exists())) continue;
    const value = (await handle.text()).trim();
    if (value.length > 0) return value;
  }
  throw new GatewayError('fatal', 'unable to read machine UUID for platform linux');
}

async function readWin32(spawn: MachineUuidSpawnFn): Promise<string> {
  const proc = spawn(
    ['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new GatewayError(
      'fatal',
      `unable to read machine UUID for platform win32 (reg exit ${exitCode.toString()})`,
    );
  }
  for (const line of stdout.split('\n')) {
    if (!line.includes('MachineGuid')) continue;
    const idx = line.indexOf('REG_SZ');
    if (idx < 0) continue;
    const value = line.slice(idx + 'REG_SZ'.length).trim();
    if (value.length > 0) return value;
  }
  throw new GatewayError('fatal', 'unable to read machine UUID for platform win32');
}

function stripQuotes(value: string): string {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

export function defaultSpawn(): MachineUuidSpawnFn {
  return (argv, options) => Bun.spawn(argv, options) as unknown as MachineUuidSpawnResult;
}

export function defaultReadFile(path: string): MachineUuidFileReader {
  const file = Bun.file(path);
  return {
    exists: () => file.exists(),
    text: () => file.text(),
  };
}
