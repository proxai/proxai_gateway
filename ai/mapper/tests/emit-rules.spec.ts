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

  test('emits .md files to .agents/rules/ with trigger always_on frontmatter', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.paths.antigravityDir = '.agents';
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const always = await readFile(join(repo, '.agents/rules/_always.md'), 'utf8');
    expect(always).toContain('Rule 1');
    expect(always).toContain('trigger: always_on');
    expect(always).toContain('description: "_always"');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.agents/rules/_always.md');
    expect(paths).toContain('.agents/rules/scoped.md');
  });

  test('codex rules contain verbatim body without any frontmatter, agent rules contain trigger without cursor details', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.paths.antigravityDir = '.agents';
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const codexContent = await readFile(join(repo, '.codex/rules', '_always.md'), 'utf8');
    expect(codexContent).not.toContain('---');
    expect(codexContent).toContain('Rule 1');

    const agentContent = await readFile(join(repo, '.agents/rules', '_always.md'), 'utf8');
    expect(agentContent).toContain('trigger: always_on');
    expect(agentContent).not.toContain('alwaysApply');
  });

  test('nested rules preserve subdirs for Claude/Antigravity but flatten for Cursor', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.paths.antigravityDir = '.agents';
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    // Nested subpath is preserved in Claude and Antigravity
    expect(await readFile(join(repo, '.claude/rules/auth/nested-rule.md'), 'utf8')).toContain(
      'Nested Rule',
    );
    expect(await readFile(join(repo, '.agents/rules/auth/nested-rule.md'), 'utf8')).toContain(
      'Nested Rule',
    );

    // Cursor is flattened: slashes replaced by hyphens
    const mdc = await readFile(join(repo, '.cursor/rules/auth-nested-rule.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('description: nested-rule');

    // Gemini gets completely skipped
    expect(
      await readFile(join(repo, '.gemini/rules/auth/nested-rule.md'), 'utf8')
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test('disabled tools are skipped', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.cursor = false;
    cfg.tools.codex = false;
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    expect(paths.some((p) => p.startsWith('.cursor/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.codex/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.agents/rules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(true);
  });

  test('rule activation modes (global, contextual, lazy-load) behave correctly', async () => {
    const tree = await loadTree(FIXTURE);

    tree.rules = [
      {
        path: 'rules/global-rule.md',
        basename: 'global-rule',
        subpath: 'global-rule',
        frontmatter: {
          name: 'Global Rule',
          description: 'A global rule description',
          activation: 'global',
        },
        body: 'Global rule body',
      },
      {
        path: 'rules/contextual-rule.md',
        basename: 'contextual-rule',
        subpath: 'contextual-rule',
        frontmatter: {
          name: 'Contextual Rule',
          description: 'A contextual rule description',
          activation: 'contextual',
          globs: ['src/**/*.ts', 'lib/**/*.js'],
        },
        body: 'Contextual rule body',
      },
      {
        path: 'rules/lazy-rule.md',
        basename: 'lazy-rule',
        subpath: 'lazy-rule',
        frontmatter: {
          name: 'Lazy Rule',
          description: 'A lazy rule description',
          activation: 'lazy-load',
        },
        body: 'Lazy rule body',
      },
    ];

    const cfg = await loadConfig(FIXTURE);
    cfg.paths.antigravityDir = '.agents';
    const mani = new Manifest(repo);
    await emitRules(repo, tree, cfg, mani);

    // Assert global rule for Claude
    const claudeGlobal = await readFile(join(repo, '.claude/rules/global-rule.md'), 'utf8');
    expect(claudeGlobal).toBe('Global rule body\n'); // empty YAML frontmatter for Claude Code

    // Assert global rule for Cursor
    const cursorGlobal = await readFile(join(repo, '.cursor/rules/global-rule.mdc'), 'utf8');
    expect(cursorGlobal).toContain('alwaysApply: true');
    expect(cursorGlobal).toContain('globs: ""');

    // Assert contextual rule for Claude
    const claudeContextual = await readFile(join(repo, '.claude/rules/contextual-rule.md'), 'utf8');
    expect(claudeContextual).toContain('---\npaths:\n  - "src/**/*.ts"\n  - "lib/**/*.js"\n---');

    // Assert contextual rule for Cursor
    const cursorContextual = await readFile(
      join(repo, '.cursor/rules/contextual-rule.mdc'),
      'utf8',
    );
    expect(cursorContextual).toContain('alwaysApply: false');
    expect(cursorContextual).toContain('globs: "src/**/*.ts, lib/**/*.js"');

    // Assert lazy-load rule does NOT emit to Claude or Cursor
    const existsClaudeLazy = await readFile(join(repo, '.claude/rules/lazy-rule.md'), 'utf8')
      .then(() => true)
      .catch(() => false);
    expect(existsClaudeLazy).toBe(false);

    const existsCursorLazy = await readFile(join(repo, '.cursor/rules/lazy-rule.mdc'), 'utf8')
      .then(() => true)
      .catch(() => false);
    expect(existsCursorLazy).toBe(false);

    // Assert lazy-load rule IS emitted to .agents/rules/ and .codex/rules/ normally
    const agentsLazy = await readFile(join(repo, '.agents/rules/lazy-rule.md'), 'utf8');
    expect(agentsLazy).toContain('trigger: model_decision');
    expect(agentsLazy).toContain('Lazy rule body');

    const codexLazy = await readFile(join(repo, '.codex/rules/lazy-rule.md'), 'utf8');
    expect(codexLazy).toBe('Lazy rule body\n');
  });
});
