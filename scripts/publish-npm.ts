#!/usr/bin/env bun

import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const NPM_BUILD_DIR = resolve(REPO_ROOT, 'npm-build');
const SHIM_SRC = resolve(REPO_ROOT, 'npm/shim.js');
const POSTINSTALL_SRC = resolve(REPO_ROOT, 'npm/postinstall.js');
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

async function readRootPackage(): Promise<RootPkg> {
  const text = await readFile(ROOT_PKG, 'utf8');
  return JSON.parse(text) as RootPkg;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function copyTo(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

async function buildNpmPackage(root: RootPkg): Promise<string> {
  const dir = NPM_BUILD_DIR;

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
    scripts: { postinstall: 'node postinstall.js' },
    engines: { node: '>=18' },
    files: ['shim.js', 'postinstall.js', 'README.md', 'LICENSE'],
    publishConfig: { access: 'public' },
  };

  await writeJson(resolve(dir, 'package.json'), pkg);
  await copyTo(SHIM_SRC, resolve(dir, 'shim.js'));
  await copyTo(POSTINSTALL_SRC, resolve(dir, 'postinstall.js'));
  await copyTo(README_SRC, resolve(dir, 'README.md'));
  await copyTo(LICENSE_SRC, resolve(dir, 'LICENSE'));

  return dir;
}

function printPublishInstructions(): void {
  const lines = [
    '',
    'npm-build/ prepared. To publish:',
    '',
    '  cd npm-build && npm publish --access public',
    '',
  ];
  for (const line of lines) console.log(line);
}

async function main(): Promise<void> {
  const root = await readRootPackage();
  console.log(`[publish-npm] preparing npm-build/ for version ${root.version}`);

  await rm(NPM_BUILD_DIR, { recursive: true, force: true });

  const dir = await buildNpmPackage(root);
  console.log(`[publish-npm] staged ${dir}`);

  printPublishInstructions();
}

await main();
