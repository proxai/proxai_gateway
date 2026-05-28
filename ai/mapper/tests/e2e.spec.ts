import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { cp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-e2e-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
  await cp(FIXTURE, join(repo, 'ai'), { recursive: true });
  await cp(join(import.meta.dir, '..'), join(repo, 'ai/mapper'), {
    recursive: true,
  });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('end-to-end sync', () => {
  test('running ai/mapper/index.ts emits all categories', async () => {
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')}`.cwd(repo).quiet().nothrow();
    expect(proc.exitCode).toBe(0);

    expect((await stat(join(repo, 'AGENTS.md'))).isFile()).toBe(true);
    expect((await stat(join(repo, 'CLAUDE.md'))).isFile()).toBe(true);

    for (const dir of ['.claude', '.cursor', '.codex', '.agents']) {
      expect((await stat(join(repo, dir))).isDirectory()).toBe(true);
    }

    expect((await stat(join(repo, '.claude/skills/sample-skill/SKILL.md'))).isFile()).toBe(true);
    expect((await stat(join(repo, '.agents/skills/sample-skill/SKILL.md'))).isFile()).toBe(true);

    expect((await stat(join(repo, '.codex/agents/reviewer.toml'))).isFile()).toBe(true);

    expect((await stat(join(repo, '.claude/rules/_always.md'))).isFile()).toBe(true);
    expect((await stat(join(repo, '.cursor/rules/_always.mdc'))).isFile()).toBe(true);
    expect((await stat(join(repo, '.codex/rules/_always.md'))).isFile()).toBe(true);
    expect((await stat(join(repo, '.agents/rules/_always.md'))).isFile()).toBe(true);

    expect((await stat(join(repo, '.claude/tools/helper.sh'))).isFile()).toBe(true);

    expect((await stat(join(repo, 'ai/.mapper-manifest.json'))).isFile()).toBe(true);
  });

  test('main docs are pure index — no inline rule content', async () => {
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')}`.cwd(repo).quiet().nothrow();
    expect(proc.exitCode).toBe(0);

    for (const docPath of ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md']) {
      const content = await readFile(join(repo, docPath), 'utf8');
      expect(content).not.toContain('## Project rules');
      expect(content).not.toContain('Rule 2');
    }
  });

  test('all main docs contain the Extending the AI memory section', async () => {
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')}`.cwd(repo).quiet().nothrow();
    expect(proc.exitCode).toBe(0);

    for (const docPath of ['AGENTS.md', 'CLAUDE.md', '.agents/AGENTS.md']) {
      const content = await readFile(join(repo, docPath), 'utf8');
      expect(content).toContain('## Extending the AI memory');
      expect(content).toContain('enhance the `ai/` source folder');
    }
  });

  test('codex and agent rules files contain verbatim body without cursor frontmatter', async () => {
    const proc = await $`bun run ${join(repo, 'ai/mapper/index.ts')}`.cwd(repo).quiet().nothrow();
    expect(proc.exitCode).toBe(0);

    for (const dir of ['.codex/rules', '.agents/rules']) {
      const content = await readFile(join(repo, dir, '_always.md'), 'utf8');
      expect(content).toContain('Rule 1');
      expect(content).not.toContain('alwaysApply');
    }
  });
});
