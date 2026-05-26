import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitRoot } from '../emitters/root';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-root-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitRoot', () => {
  test('writes CLAUDE.md, AGENTS.md, GEMINI.md, and .agent/AGENTS.md', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    expect(claude).toContain('fixture-repo');
    expect(agents).toContain('fixture-repo');
    expect(gemini).toContain('fixture-repo');
    expect(agentAgents).toContain('fixture-repo');

    const paths = mani
      .files()
      .map((f) => f.path)
      .toSorted();
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('GEMINI.md');
    expect(paths).toContain('.agent/AGENTS.md');
  });

  test('CLAUDE.md has Claude Code orchestration section and file tree but no Project rules', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');

    expect(claude).toContain('Your orchestration (Claude Code)');
    expect(claude).toContain('Repository structure');
    expect(claude).toContain('Domain knowledge index');
    expect(claude).not.toContain('Project rules');
    expect(claude).toContain('.claude/rules/*.md');
    expect(claude).toContain('.claude/knowledge/*.md');
    expect(claude).toContain('auto-loads');
  });

  test('AGENTS.md has Codex CLI and Cursor subsections, knowledge, and no Project rules', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');

    expect(agents).toContain('Codex CLI');
    expect(agents).toContain('Cursor');
    expect(agents).toContain('Repository structure');
    expect(agents).toContain('Domain knowledge index');
    expect(agents).not.toContain('Project rules');
    expect(agents).not.toContain('Rule 1');
    expect(agents).toContain('.codex/rules/*.md');
    expect(agents).toContain('.cursor/rules/*.mdc');
    expect(agents).toContain('.codex/knowledge/*.md');
    expect(agents).toContain('.cursor/knowledge/*.md');
  });

  test('GEMINI.md has Gemini CLI orchestration section, knowledge, and no Project rules', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');

    expect(gemini).toContain('Your orchestration (Gemini CLI)');
    expect(gemini).toContain('Repository structure');
    expect(gemini).toContain('Domain knowledge index');
    expect(gemini).not.toContain('Project rules');
    expect(gemini).not.toContain('Rule 1');
    expect(gemini).toContain('.gemini/rules/*.md');
    expect(gemini).toContain('.gemini/knowledge/*.md');
  });

  test('.agent/AGENTS.md has Antigravity orchestration section and no Project rules', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    expect(agentAgents).toContain('Your orchestration (Antigravity)');
    expect(agentAgents).toContain('Repository structure');
    expect(agentAgents).toContain('Domain knowledge index');
    expect(agentAgents).not.toContain('Project rules');
    expect(agentAgents).not.toContain('Rule 1');
    expect(agentAgents).toContain('.agent/rules/*.md');
    expect(agentAgents).toContain('.agent/knowledge/*.md');
    expect(agentAgents).toContain('auto-loads');
  });

  test('all 4 files have the file tree section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).toContain('## Repository structure');
    }
  });

  test('all 4 files start with the project preamble', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc.startsWith('# fixture-repo')).toBe(true);
    }
  });

  test('CLAUDE.md and AGENTS.md have different content', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');

    expect(claude).not.toBe(agents);
  });

  test('skips tools that are disabled', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.gemini = false;
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    expect(
      await lstat(join(repo, 'CLAUDE.md'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await lstat(join(repo, 'GEMINI.md'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(
      await lstat(join(repo, '.agent/AGENTS.md'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test('none of the 4 docs contain inline rule content', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).not.toContain('## Project rules');
    }
  });

  test('none of the 4 docs inline the knowledge bodies (lean root contract)', async () => {
    // The fixture's knowledge files contain known body strings that MUST NOT
    // appear in the root docs anymore — root docs only carry the index, not
    // the bodies.
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).not.toContain('Key fact from k1.');
      expect(doc).not.toContain('Demonstrates that the mapper picks up');
    }
  });

  test('all 4 docs contain the Extending the AI memory section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).toContain('## Extending the AI memory');
      expect(doc).toContain('enhance the `ai/` source folder');
      expect(doc).toContain('bun run ai/mapper/index.ts');
      expect(doc).toContain('Never edit files inside `.<tool>/` directly');
    }
  });

  test('all 4 docs include a knowledge index pointing at on-disk paths', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    // Each doc's index uses its own tool dir as the path prefix.
    expect(claude).toContain('## Domain knowledge index');
    expect(claude).toContain('| Path | Topic |');
    expect(claude).toContain('`.claude/knowledge/k1.md`');
    expect(claude).toContain('`.claude/knowledge/arch.md`');
    expect(claude).toContain('`.claude/knowledge/area/nested-knowledge.md`');

    // AGENTS.md uses .codex/ as the canonical (mirrored to .cursor/).
    expect(agents).toContain('`.codex/knowledge/k1.md`');

    expect(gemini).toContain('`.gemini/knowledge/k1.md`');
    expect(agentAgents).toContain('`.agent/knowledge/k1.md`');
  });

  test('index extracts the H1 as the topic description, falling back to basename', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    // k1.md starts with `# k1`, arch.md with `# Arch`. The H1 marker is stripped.
    expect(claude).toMatch(/`\.claude\/knowledge\/k1\.md`\s+\|\s+k1\s/);
    expect(claude).toMatch(/`\.claude\/knowledge\/arch\.md`\s+\|\s+Arch\s/);
  });

  test('AGENTS.md falls back to .cursor/ when only cursor is enabled', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.codex = false;
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('`.cursor/knowledge/k1.md`');
    expect(agents).not.toContain('`.codex/knowledge/k1.md`');
  });

  test('when docs/ does not exist, none of the 4 docs contain Project documentation section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).not.toContain('## Project documentation');
    }
  });

  test('when docs/ exists at repo root, all 4 docs contain Project documentation section', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'README.md'), '# Docs placeholder\n');

    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const gemini = await readFile(join(repo, 'GEMINI.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agent/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, gemini, agentAgents]) {
      expect(doc).toContain('## Project documentation');
      expect(doc).toContain('Read `docs/` at the repo root');
    }
  });
});
