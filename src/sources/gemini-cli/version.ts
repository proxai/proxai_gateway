import { readFileSync } from 'node:fs';
import { join, win32 as pathWin32 } from 'node:path';

export interface DetectGeminiCliVersionDeps {
  homedir: string;
  platform: NodeJS.Platform;
  appdata?: string | undefined;
  readJsonSync?: (path: string) => unknown;
  glob?: (pattern: string) => string[];
}

const PACKAGE_PATH_SUFFIX = join('lib', 'node_modules', '@google', 'gemini-cli', 'package.json');
const VERSION_PATTERN = /^[\w.+:/-]{1,64}$/;

export function detectGeminiCliVersion(deps: DetectGeminiCliVersionDeps): string | null {
  const readJsonSync = deps.readJsonSync ?? defaultReadJsonSync;
  const glob = deps.glob ?? defaultGlob;

  const candidates = buildCandidatePaths(deps, glob);
  for (const path of candidates) {
    const version = readVersionAt(path, readJsonSync);
    if (version !== null) return version;
  }
  return null;
}

function buildCandidatePaths(
  deps: DetectGeminiCliVersionDeps,
  glob: (pattern: string) => string[],
): string[] {
  const paths: string[] = [];
  const nvmPattern = join(
    deps.homedir,
    '.nvm',
    'versions',
    'node',
    '*',
    'lib',
    'node_modules',
    '@google',
    'gemini-cli',
    'package.json',
  );
  const nvmMatches = glob(nvmPattern).toSorted(compareNvmVersionDesc);
  for (const match of nvmMatches) paths.push(match);

  paths.push(join('/usr/local', PACKAGE_PATH_SUFFIX));
  paths.push(join('/opt/homebrew', PACKAGE_PATH_SUFFIX));
  paths.push(
    join(
      deps.homedir,
      '.bun',
      'install',
      'global',
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json',
    ),
  );
  paths.push(
    join(
      deps.homedir,
      '.local',
      'share',
      'pnpm',
      'global',
      '5',
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json',
    ),
  );
  paths.push(join(deps.homedir, '.npm-global', PACKAGE_PATH_SUFFIX));

  if (deps.platform === 'win32') {
    const appdata = deps.appdata;
    if (typeof appdata === 'string' && appdata.length > 0) {
      paths.push(
        pathWin32.join(appdata, 'npm', 'node_modules', '@google', 'gemini-cli', 'package.json'),
      );
    }
  }
  return paths;
}

function readVersionAt(path: string, readJsonSync: (path: string) => unknown): string | null {
  let parsed: unknown;
  try {
    parsed = readJsonSync(path);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') return null;
  if (!VERSION_PATTERN.test(version)) return null;
  return version;
}

function defaultReadJsonSync(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultGlob(pattern: string): string[] {
  const results: string[] = [];
  try {
    const scan = new Bun.Glob(pattern).scanSync({ absolute: true, onlyFiles: true });
    for (const match of scan) results.push(match);
  } catch {
    return [];
  }
  return results;
}

function compareNvmVersionDesc(a: string, b: string): number {
  const av = extractNvmVersion(a);
  const bv = extractNvmVersion(b);
  return compareVersionTriples(bv, av);
}

function extractNvmVersion(path: string): readonly [number, number, number] {
  const match = /\.nvm\/versions\/node\/v?(\d+)\.(\d+)\.(\d+)\//.exec(path);
  if (match === null) return [0, 0, 0];
  return [
    Number.parseInt(match[1] ?? '0', 10),
    Number.parseInt(match[2] ?? '0', 10),
    Number.parseInt(match[3] ?? '0', 10),
  ];
}

function compareVersionTriples(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
