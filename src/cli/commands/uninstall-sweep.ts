export type SweepablePm = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PmDetection {
  name: SweepablePm;
  available: boolean;
  installed: boolean;
}

export interface BrewDetection {
  available: boolean;
  installed: boolean;
}

export interface SweepActionResult {
  ok: boolean;
  message: string;
}

export interface PackageManagerSweep {
  detectAll(): Promise<PmDetection[]>;
  uninstall(name: SweepablePm): Promise<SweepActionResult>;
  detectBrew(): Promise<BrewDetection>;
  uninstallBrew(): Promise<SweepActionResult>;
}

export interface CommandRunner {
  exec(file: string, args: string[]): Promise<{ stdout: string; ok: boolean }>;
  has(cmd: string): Promise<boolean>;
}

const PKG = '@proxai/gateway';
const BREW_FORMULA = 'proxai-gateway';

export function parseNpmLs(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { dependencies?: Record<string, unknown> };
    return parsed.dependencies !== undefined && parsed.dependencies[PKG] !== undefined;
  } catch {
    return false;
  }
}

export function parsePnpmLs(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as Array<{ dependencies?: Record<string, unknown> }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    const first = parsed[0];
    if (first === undefined) return false;
    return first.dependencies !== undefined && first.dependencies[PKG] !== undefined;
  } catch {
    return false;
  }
}

export function parseYarnList(text: string): boolean {
  return text.split('\n').some((line) => line.includes(`"${PKG}@`));
}

export function parseBunPmLs(text: string): boolean {
  return text.includes(PKG);
}

export const realCommandRunner: CommandRunner = {
  exec: async (file, args) => {
    try {
      const proc = Bun.spawn([file, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { stdout, ok: proc.exitCode === 0 };
    } catch {
      return { stdout: '', ok: false };
    }
  },
  has: async (cmd) => {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    return (await realCommandRunner.exec(lookup, [cmd])).ok;
  },
};

export function createSweep(runner: CommandRunner): PackageManagerSweep {
  const detectors: Array<{ name: SweepablePm; args: string[]; parse: (text: string) => boolean }> =
    [
      { name: 'npm', args: ['ls', '-g', '--depth=0', '--json', PKG], parse: parseNpmLs },
      { name: 'pnpm', args: ['ls', '-g', '--depth=0', '--json', PKG], parse: parsePnpmLs },
      { name: 'yarn', args: ['global', 'list', '--json'], parse: parseYarnList },
      { name: 'bun', args: ['pm', 'ls', '-g'], parse: parseBunPmLs },
    ];

  const uninstallArgs: Record<SweepablePm, string[]> = {
    npm: ['uninstall', '-g', PKG],
    pnpm: ['uninstall', '-g', PKG],
    yarn: ['global', 'remove', PKG],
    bun: ['remove', '-g', PKG],
  };

  return {
    detectAll: async () => {
      const results: PmDetection[] = [];
      for (const d of detectors) {
        const available = await runner.has(d.name);
        if (!available) {
          results.push({ name: d.name, available: false, installed: false });
          continue;
        }
        const { stdout, ok } = await runner.exec(d.name, d.args);
        const installed = ok || stdout.length > 0 ? d.parse(stdout) : false;
        results.push({ name: d.name, available: true, installed });
      }
      return results;
    },
    uninstall: async (name) => {
      const { ok, stdout } = await runner.exec(name, uninstallArgs[name]);
      if (ok) return { ok: true, message: `removed via ${name}` };
      const detail = stdout.length > 0 ? stdout.trim().split('\n').slice(-1)[0] : 'non-zero exit';
      return { ok: false, message: `${name} uninstall failed: ${detail ?? 'non-zero exit'}` };
    },
    detectBrew: async () => {
      const available = await runner.has('brew');
      if (!available) return { available: false, installed: false };
      const { ok } = await runner.exec('brew', ['list', '--formula', '--versions', BREW_FORMULA]);
      return { available: true, installed: ok };
    },
    uninstallBrew: async () => {
      const { ok, stdout } = await runner.exec('brew', ['uninstall', BREW_FORMULA]);
      if (ok) return { ok: true, message: 'removed via brew' };
      const detail = stdout.length > 0 ? stdout.trim().split('\n').slice(-1)[0] : 'non-zero exit';
      return { ok: false, message: `brew uninstall failed: ${detail ?? 'non-zero exit'}` };
    },
  };
}

export function createDefaultSweep(): PackageManagerSweep {
  return createSweep(realCommandRunner);
}

export function isDirectBinary(execPath: string): boolean {
  if (execPath.includes('/node_modules/')) return false;
  if (execPath.includes('\\node_modules\\')) return false;
  if (execPath.includes('/Cellar/')) return false;
  return true;
}
