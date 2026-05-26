import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitRules } from '../emitters/rules';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-rules-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitRules', () => {
  test('emits .md files to .claude/rules/ verbatim', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const always = await readFile(join(repo, '.claude/rules/_always.md'), 'utf8');
    expect(always).toContain('Rule 1');
    expect(always).not.toContain('---');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/rules/_always.md');
    expect(paths).toContain('.claude/rules/scoped.md');
  });

  test('emits .mdc files to .cursor/rules/ with alwaysApply frontmatter', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const mdc = await readFile(join(repo, '.cursor/rules/_always.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('description: _always');
    expect(mdc).toContain('Rule 1');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.cursor/rules/_always.mdc');
    expect(paths).toContain('.cursor/rules/scoped.mdc');
  });

  test('emits .md files to .codex/rules/ verbatim', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const always = await readFile(join(repo, '.codex/rules/_always.md'), 'utf8');
    expect(always).toContain('Rule 1');
    expect(always).not.toContain('---');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.codex/rules/_always.md');
    expect(paths).toContain('.codex/rules/scoped.md');
  });

  test('emits .md files to .gemini/rules/ verbatim', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const always = await readFile(join(repo, '.gemini/rules/_always.md'), 'utf8');
    expect(always).toContain('Rule 1');
    expect(always).not.toContain('---');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.gemini/rules/_always.md');
    expect(paths).toContain('.gemini/rules/scoped.md');
  });

  test('emits .md files to .agent/rules/ verbatim', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const always = await readFile(join(repo, '.agent/rules/_always.md'), 'utf8');
    expect(always).toContain('Rule 1');
    expect(always).not.toContain('---');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.agent/rules/_always.md');
    expect(paths).toContain('.agent/rules/scoped.md');
  });

  test('codex/gemini/agent rules files contain verbatim body without cursor frontmatter', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    for (const dir of ['.codex/rules', '.gemini/rules', '.agent/rules']) {
      const content = await readFile(join(repo, dir, '_always.md'), 'utf8');
      expect(content).not.toContain('alwaysApply');
      expect(content).not.toContain('description:');
    }
  });

  test('nested rules preserve subdir layout across every tool', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    // .claude / .codex / .gemini / .agent → .md under same subdir
    for (const dir of ['.claude/rules', '.codex/rules', '.gemini/rules', '.agent/rules']) {
      const content = await readFile(join(repo, dir, 'auth/nested-rule.md'), 'utf8');
      expect(content).toContain('Nested Rule');
    }

    // .cursor → .mdc under same subdir, with frontmatter
    const mdc = await readFile(join(repo, '.cursor/rules/auth/nested-rule.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('description: nested-rule');
    expect(mdc).toContain('Nested Rule');

    // manifest records the nested paths
    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/rules/auth/nested-rule.md');
    expect(paths).toContain('.cursor/rules/auth/nested-rule.mdc');
    expect(paths).toContain('.codex/rules/auth/nested-rule.md');
    expect(paths).toContain('.gemini/rules/auth/nested-rule.md');
    expect(paths).toContain('.agent/rules/auth/nested-rule.md');
  });

  test('disabled tools are skipped', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.cursor = false;
    cfg.tools.codex = false;
    cfg.tools.gemini = false;
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    expect(paths.some((p) => p.startsWith('.cursor/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.codex/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.gemini/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.agent/rules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(true);
  });
});
