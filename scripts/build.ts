#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface Target {
  readonly platform: 'darwin' | 'linux' | 'windows';
  readonly arch: 'arm64' | 'x64';
}

const TARGETS: readonly Target[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'windows', arch: 'x64' },
  { platform: 'windows', arch: 'arm64' },
];

const REPO_ROOT = resolve(import.meta.dir, '..');
const ENTRY = resolve(REPO_ROOT, 'src/main.ts');

function outfileFor(target: Target): string {
  const suffix = target.platform === 'windows' ? '.exe' : '';
  return resolve(REPO_ROOT, `dist/${target.platform}-${target.arch}/proxai-gateway${suffix}`);
}

function targetFlag(target: Target): string {
  return `bun-${target.platform}-${target.arch}`;
}

async function buildOne(target: Target): Promise<number> {
  const outfile = outfileFor(target);
  await mkdir(dirname(outfile), { recursive: true });

  const flag = targetFlag(target);
  console.log(`[build] ${flag} -> ${outfile}`);

  const proc = Bun.spawn({
    cmd: ['bun', 'build', '--compile', `--target=${flag}`, `--outfile=${outfile}`, ENTRY],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const code = await proc.exited;
  if (code === 0) {
    console.log(`[build] ${flag} ok`);
  } else {
    console.error(`[build] ${flag} failed with exit code ${code.toString()}`);
  }
  return code;
}

function parseSelection(argv: readonly string[]): readonly Target[] {
  if (argv.length === 0) return TARGETS;

  const selected: Target[] = [];
  for (const arg of argv) {
    const match = TARGETS.find((t) => `${t.platform}-${t.arch}` === arg);
    if (match === undefined) {
      console.error(`[build] unknown target: ${arg}`);
      console.error(
        `[build] valid targets: ${TARGETS.map((t) => `${t.platform}-${t.arch}`).join(', ')}`,
      );
      process.exit(2);
    }
    selected.push(match);
  }
  return selected;
}

async function main(): Promise<void> {
  const selection = parseSelection(process.argv.slice(2));
  console.log(`[build] building ${selection.length.toString()} target(s) from ${ENTRY}`);

  for (const target of selection) {
    const code = await buildOne(target);
    if (code !== 0) process.exit(code);
  }

  console.log('[build] all targets built successfully');
}

await main();
