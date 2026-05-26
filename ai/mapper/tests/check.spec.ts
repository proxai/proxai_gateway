import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-check-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
  await cp(FIXTURE, join(repo, 'ai'), { recursive: true });
  await cp(join(import.meta.dir, '..'), join(repo, 'ai/mapper'), {
    recursive: true,
  });
  await $`bun run ${join(repo, 'ai/mapper/index.ts')}`.cwd(repo).quiet().nothrow();
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('check mode', () => {
  test('clean sync → check exits 0', async () => {
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')} --check`
      .cwd(repo)
      .quiet()
      .nothrow();
    expect(proc.exitCode).toBe(0);
  });

  test('modify ai/ then check → exits 1 with drift', async () => {
    await writeFile(join(repo, 'ai/rules/_always.md'), `- New rule X.\n`);
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')} --check`
      .cwd(repo)
      .quiet()
      .nothrow();
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toMatch(/DRIFT/);
  });
});
