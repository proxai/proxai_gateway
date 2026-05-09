import { readFileSync } from 'node:fs';
import { join, win32 as pathWin32 } from 'node:path';

export interface DetectGeminiCliVersionDeps {
  homedir: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readJsonSync?: (path: string) => unknown;
  glob?: (pattern: string) => string[];
  which?: (cmd: string) => string | null;
  spawn?: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const PACKAGE_PATH_SUFFIX = join('lib', 'node_modules', '@google', 'gemini-cli', 'package.json');
const VERSION_PATTERN = /^[\w.+:/-]{1,64}$/;
const GITHUB_LATEST_URL = 'https://api.github.com/repos/google-gemini/gemini-cli/releases/latest';
const SPAWN_TIMEOUT_MS = 3_000;
const FETCH_TIMEOUT_MS = 5_000;

let layer3Cache: { value: string | null } | null = null;

export function __resetLayer3Cache(): void {
  layer3Cache = null;
}

export async function detectGeminiCliVersion(
  deps: DetectGeminiCliVersionDeps,
): Promise<string | null> {
  const layer1 = await runLayer1(deps);
  if (layer1 !== null) return layer1;

  const layer2 = runLayer2(deps);
  if (layer2 !== null) return layer2;

  return runLayer3(deps);
}

async function runLayer1(deps: DetectGeminiCliVersionDeps): Promise<string | null> {
  const which = deps.which ?? defaultWhich;
  const spawn = deps.spawn ?? defaultSpawn;

  const resolved = which('gemini');
  if (resolved === null) return null;

  let outcome: { stdout: string; exitCode: number };
  try {
    outcome = await spawn([resolved, '--version']);
  } catch {
    return null;
  }
  if (outcome.exitCode !== 0) return null;
  const firstLine = outcome.stdout.trim().split('\n')[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return null;
  if (!VERSION_PATTERN.test(firstLine)) return null;
  return firstLine;
}

function runLayer2(deps: DetectGeminiCliVersionDeps): string | null {
  const readJsonSync = deps.readJsonSync ?? defaultReadJsonSync;
  const glob = deps.glob ?? defaultGlob;
  const candidates = buildCandidatePaths(deps, glob);
  for (const path of candidates) {
    const version = readVersionAt(path, readJsonSync);
    if (version !== null) return version;
  }
  return null;
}

async function runLayer3(deps: DetectGeminiCliVersionDeps): Promise<string | null> {
  if (layer3Cache !== null) return layer3Cache.value;
  const value = await fetchGithubLatest(deps);
  layer3Cache = { value };
  return value;
}

async function fetchGithubLatest(deps: DetectGeminiCliVersionDeps): Promise<string | null> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_LATEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'proxai-gateway',
        Accept: 'application/vnd.github+json',
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') return null;
  const tagName = (body as { tag_name?: unknown }).tag_name;
  if (typeof tagName !== 'string') return null;
  const version = tagName.replace(/^v/, '');
  if (!VERSION_PATTERN.test(version)) return null;
  return version;
}

function buildCandidatePaths(
  deps: DetectGeminiCliVersionDeps,
  glob: (pattern: string) => string[],
): string[] {
  if (deps.platform === 'win32') return buildWindowsCandidates(deps, glob);
  return buildPosixCandidates(deps, glob);
}

function buildPosixCandidates(
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
  for (const match of glob(nvmPattern).toSorted(compareNvmVersionDesc)) {
    paths.push(match);
  }

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

  const asdfPattern = join(
    deps.homedir,
    '.asdf',
    'installs',
    'nodejs',
    '*',
    'lib',
    'node_modules',
    '@google',
    'gemini-cli',
    'package.json',
  );
  for (const match of glob(asdfPattern)) paths.push(match);

  const rtxPattern = join(
    deps.homedir,
    '.local',
    'share',
    'rtx',
    'installs',
    'node',
    '*',
    'lib',
    'node_modules',
    '@google',
    'gemini-cli',
    'package.json',
  );
  for (const match of glob(rtxPattern)) paths.push(match);

  const misePattern = join(
    deps.homedir,
    '.local',
    'share',
    'mise',
    'installs',
    'node',
    '*',
    'lib',
    'node_modules',
    '@google',
    'gemini-cli',
    'package.json',
  );
  for (const match of glob(misePattern)) paths.push(match);

  paths.push(join(deps.homedir, '.npm-global', PACKAGE_PATH_SUFFIX));

  if (deps.platform === 'darwin') {
    paths.push(join('/opt/homebrew', PACKAGE_PATH_SUFFIX));
    paths.push(join('/usr/local', PACKAGE_PATH_SUFFIX));
  } else if (deps.platform === 'linux') {
    paths.push(join('/usr/local', PACKAGE_PATH_SUFFIX));
    paths.push(join('/usr', PACKAGE_PATH_SUFFIX));
    paths.push(join('/snap/node/current', PACKAGE_PATH_SUFFIX));
  }

  return paths;
}

function buildWindowsCandidates(
  deps: DetectGeminiCliVersionDeps,
  glob: (pattern: string) => string[],
): string[] {
  const env = deps.env ?? {};
  const appdata = env['APPDATA'];
  const localAppdata = env['LOCALAPPDATA'];
  const userProfile = env['USERPROFILE'];
  const paths: string[] = [];

  if (typeof appdata === 'string' && appdata.length > 0) {
    paths.push(
      pathWin32.join(appdata, 'npm', 'node_modules', '@google', 'gemini-cli', 'package.json'),
    );
    const nvmPattern = pathWin32.join(
      appdata,
      'nvm',
      'v*',
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json',
    );
    for (const match of glob(nvmPattern).toSorted(compareNvmWindowsVersionDesc)) {
      paths.push(match);
    }
  }

  if (typeof userProfile === 'string' && userProfile.length > 0) {
    paths.push(
      pathWin32.join(
        userProfile,
        'scoop',
        'persist',
        'nodejs',
        'node_modules',
        '@google',
        'gemini-cli',
        'package.json',
      ),
    );
    paths.push(
      pathWin32.join(
        userProfile,
        '.bun',
        'install',
        'global',
        'node_modules',
        '@google',
        'gemini-cli',
        'package.json',
      ),
    );
  }

  if (typeof localAppdata === 'string' && localAppdata.length > 0) {
    const fnmPattern = pathWin32.join(
      localAppdata,
      'fnm',
      'node-versions',
      'v*',
      'installation',
      'node_modules',
      '@google',
      'gemini-cli',
      'package.json',
    );
    for (const match of glob(fnmPattern).toSorted(compareNvmWindowsVersionDesc)) {
      paths.push(match);
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

function defaultWhich(cmd: string): string | null {
  return Bun.which(cmd);
}

async function defaultSpawn(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

function compareNvmVersionDesc(a: string, b: string): number {
  return compareVersionTriples(extractNvmVersion(b), extractNvmVersion(a));
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

function compareNvmWindowsVersionDesc(a: string, b: string): number {
  return compareVersionTriples(extractWinNodeVersion(b), extractWinNodeVersion(a));
}

function extractWinNodeVersion(path: string): readonly [number, number, number] {
  const match = /[\\/]v?(\d+)\.(\d+)\.(\d+)[\\/]/.exec(path);
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
