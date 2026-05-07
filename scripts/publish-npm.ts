#!/usr/bin/env bun
//
// Prepare npm packages for the gateway under `npm-build/`.
//
// This script does NOT publish. It builds (or reuses) the platform binaries,
// stages 7 npm package directories (1 main + 6 platform-specific), and prints
// the manual `npm publish` commands the maintainer should run.
//
// Usage: `bun scripts/publish-npm.ts [--build]`
//   --build  Run `bun run build` first to refresh dist/ before staging.

import { mkdir, readFile, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface Target {
  /** dist/ directory name (matches build.ts: "darwin", "linux", "windows"). */
  readonly buildPlatform: 'darwin' | 'linux' | 'windows';
  readonly buildArch: 'arm64' | 'x64';
  /** Node `process.platform` value used in npm `os` and package names. */
  readonly nodePlatform: 'darwin' | 'linux' | 'win32';
  readonly nodeArch: 'arm64' | 'x64';
}

const TARGETS: readonly Target[] = [
  { buildPlatform: 'darwin', buildArch: 'arm64', nodePlatform: 'darwin', nodeArch: 'arm64' },
  { buildPlatform: 'darwin', buildArch: 'x64', nodePlatform: 'darwin', nodeArch: 'x64' },
  { buildPlatform: 'linux', buildArch: 'arm64', nodePlatform: 'linux', nodeArch: 'arm64' },
  { buildPlatform: 'linux', buildArch: 'x64', nodePlatform: 'linux', nodeArch: 'x64' },
  { buildPlatform: 'windows', buildArch: 'x64', nodePlatform: 'win32', nodeArch: 'x64' },
  { buildPlatform: 'windows', buildArch: 'arm64', nodePlatform: 'win32', nodeArch: 'arm64' },
];

const REPO_ROOT = resolve(import.meta.dir, '..');
const DIST_DIR = resolve(REPO_ROOT, 'dist');
const NPM_BUILD_DIR = resolve(REPO_ROOT, 'npm-build');
const SHIM_SRC = resolve(REPO_ROOT, 'npm/shim.js');
const README_SRC = resolve(REPO_ROOT, 'README.md');
const LICENSE_SRC = resolve(REPO_ROOT, 'LICENSE');
const ROOT_PKG = resolve(REPO_ROOT, 'package.json');

interface RootPkg {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly homepage: string;
  readonly repository: unknown;
  readonly bugs: unknown;
  readonly keywords: readonly string[];
  readonly author: string;
  readonly license: string;
}

function targetLabel(t: Target): string {
  return `${t.nodePlatform}-${t.nodeArch}`;
}

function buildLabel(t: Target): string {
  return `${t.buildPlatform}-${t.buildArch}`;
}

function binaryExt(t: Target): '.exe' | '' {
  return t.nodePlatform === 'win32' ? '.exe' : '';
}

function distBinaryPath(t: Target): string {
  return resolve(DIST_DIR, buildLabel(t), `proxai-gateway${binaryExt(t)}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readRootPackage(): Promise<RootPkg> {
  const text = await readFile(ROOT_PKG, 'utf8');
  return JSON.parse(text) as RootPkg;
}

async function ensureBinariesPresent(autoBuild: boolean): Promise<void> {
  const missing: Target[] = [];
  for (const t of TARGETS) {
    const path = distBinaryPath(t);
    if (!(await fileExists(path))) missing.push(t);
  }

  if (missing.length === 0) return;

  if (!autoBuild) {
    console.error('[publish-npm] missing platform binaries:');
    for (const t of missing) {
      console.error(`  - ${distBinaryPath(t)}`);
    }
    console.error('[publish-npm] run `bun run build` first, or rerun with --build.');
    process.exit(1);
  }

  console.log('[publish-npm] running `bun run build` to refresh dist/...');
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'build'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`[publish-npm] build failed with exit code ${code.toString()}`);
    process.exit(code);
  }

  for (const t of missing) {
    if (!(await fileExists(distBinaryPath(t)))) {
      console.error(
        `[publish-npm] expected binary still missing after build: ${distBinaryPath(t)}`,
      );
      process.exit(1);
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function copyTo(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function buildPlatformPackage(root: RootPkg, t: Target): Promise<string> {
  const label = targetLabel(t);
  const dir = resolve(NPM_BUILD_DIR, 'platform', label);
  const ext = binaryExt(t);
  const binaryName = `proxai-gateway${ext}`;

  const pkg = {
    name: `@proxai/gateway-${label}`,
    version: root.version,
    description: `Pre-compiled ProxAI Gateway binary for ${label}`,
    homepage: root.homepage,
    repository: root.repository,
    bugs: root.bugs,
    license: root.license,
    author: root.author,
    os: [t.nodePlatform],
    cpu: [t.nodeArch],
    files: [binaryName],
    publishConfig: { access: 'public' },
  };

  await writeJson(resolve(dir, 'package.json'), pkg);
  await copyTo(distBinaryPath(t), resolve(dir, binaryName));

  return dir;
}

async function buildMainPackage(root: RootPkg): Promise<string> {
  const dir = resolve(NPM_BUILD_DIR, 'main');

  const optionalDependencies: Record<string, string> = {};
  for (const t of TARGETS) {
    optionalDependencies[`@proxai/gateway-${targetLabel(t)}`] = root.version;
  }

  const pkg = {
    name: '@proxai/gateway',
    version: root.version,
    description: root.description,
    homepage: root.homepage,
    repository: root.repository,
    bugs: root.bugs,
    keywords: root.keywords,
    author: root.author,
    license: root.license,
    bin: { 'proxai-gateway': './shim.js' },
    files: ['shim.js', 'README.md', 'LICENSE'],
    engines: { node: '>=18' },
    optionalDependencies,
    publishConfig: { access: 'public' },
  };

  await writeJson(resolve(dir, 'package.json'), pkg);
  await copyTo(SHIM_SRC, resolve(dir, 'shim.js'));
  await copyTo(README_SRC, resolve(dir, 'README.md'));
  await copyTo(LICENSE_SRC, resolve(dir, 'LICENSE'));

  return dir;
}

function printPublishInstructions(): void {
  const lines = [
    '',
    'npm-build/ prepared. To publish:',
    '',
    '  cd npm-build/platform/darwin-arm64 && npm publish --access public',
    '  cd npm-build/platform/darwin-x64   && npm publish --access public',
    '  cd npm-build/platform/linux-arm64  && npm publish --access public',
    '  cd npm-build/platform/linux-x64    && npm publish --access public',
    '  cd npm-build/platform/win32-x64    && npm publish --access public',
    '  cd npm-build/platform/win32-arm64  && npm publish --access public',
    '  cd npm-build/main                  && npm publish --access public',
    '',
    'Platform packages must publish BEFORE main (optionalDependencies resolution).',
    '',
  ];
  for (const line of lines) console.log(line);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const autoBuild = argv.includes('--build');

  const root = await readRootPackage();
  console.log(`[publish-npm] preparing npm-build/ for version ${root.version}`);

  await ensureBinariesPresent(autoBuild);

  await rm(NPM_BUILD_DIR, { recursive: true, force: true });

  for (const t of TARGETS) {
    const dir = await buildPlatformPackage(root, t);
    console.log(`[publish-npm] staged ${dir}`);
  }

  const mainDir = await buildMainPackage(root);
  console.log(`[publish-npm] staged ${mainDir}`);

  printPublishInstructions();
}

await main();
