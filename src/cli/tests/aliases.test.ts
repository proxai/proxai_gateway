import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { COMMAND_ALIASES } from 'cli/command-aliases.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'src', 'main.ts');

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
    if (name === 'dev') continue;
    expect(help).toContain(`${name}|${alias}`);
  }
});

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
