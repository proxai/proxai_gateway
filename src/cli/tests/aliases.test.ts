import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { COMMAND_ALIASES } from 'cli/command-aliases.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'src', 'main.ts');

const DEV_MODE_ONLY_COMMANDS = new Set(['dev', 'inspect', 'tail']);

async function runHelp(): Promise<string> {
  const proc = Bun.spawn(['bun', ENTRY, '--help'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${stdout}\n${stderr}`;
}

test('every long command has its declared alias visible in --help output', async () => {
  const help = await runHelp();
  for (const [name, alias] of Object.entries(COMMAND_ALIASES)) {
    if (DEV_MODE_ONLY_COMMANDS.has(name)) continue;
    expect(help).toContain(`${name}|${alias}`);
  }
}, 30_000);

test('hidden dev command still resolves under its short alias d', async () => {
  expect(COMMAND_ALIASES['dev']).toBe('d');
});

test('alias map asserts the full set of long-command keys', () => {
  expect(Object.keys(COMMAND_ALIASES).toSorted()).toEqual(
    [
      'dev',
      'inspect',
      'restart',
      'setup',
      'start',
      'status',
      'stop',
      'tail',
      'uninstall',
    ].toSorted(),
  );
});

test('alias values are unique short identifiers', () => {
  const values = Object.values(COMMAND_ALIASES);
  expect(new Set(values).size).toBe(values.length);
});

test('setup new parses the positional gateway key instead of prompting', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'proxai-aliases-'));
  try {
    const proc = Bun.spawn(['bun', ENTRY, 'setup', 'new', 'badnohyphens'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, PROXAI_TEST_PROFILE_ROOT: sandbox },
    });
    const killer = setTimeout(() => proc.kill(), 8_000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(killer);
    expect(`${stdout}${stderr}`).toContain('invalid format');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);
