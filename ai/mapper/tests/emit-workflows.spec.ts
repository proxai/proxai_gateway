import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitWorkflows } from '../emitters/workflows';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-wf-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
  await cp(FIXTURE, join(repo, 'ai'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitWorkflows', () => {
  test('emits modern skills and flat commands to Claude, Cursor, and Antigravity while skipping Gemini', async () => {
    const tree = await loadTree(join(repo, 'ai'));
    const cfg = await loadConfig(join(repo, 'ai'));
    cfg.paths.antigravityDir = '.agents';
    const mani = new Manifest(repo);
    await emitWorkflows(repo, tree, cfg, mani);

    // Claude Skills
    expect(await readFile(join(repo, '.claude/skills/audit/SKILL.md'), 'utf8')).toContain(
      'description: Run an audit',
    );
    expect(await readFile(join(repo, '.claude/skills/audit/SKILL.md'), 'utf8')).toContain(
      'name: audit',
    );

    // Cursor Command
    expect(await readFile(join(repo, '.cursor/commands/audit.md'), 'utf8')).toContain(
      'Audit the codebase',
    );

    // Antigravity skills & slash commands
    expect(await readFile(join(repo, '.agents/skills/audit/SKILL.md'), 'utf8')).toContain(
      'name: audit',
    );
    expect(await readFile(join(repo, '.agents/skills/audit.md'), 'utf8')).toContain(
      'Audit the codebase',
    );

    // Gemini CLI is completely wiped
    const geminiPath = join(repo, '.gemini/commands/audit.toml');
    expect(
      await readFile(geminiPath, 'utf8')
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    const codexPath = join(repo, '.codex/commands/audit.md');
    expect(
      await readFile(codexPath, 'utf8')
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});
