import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, lstat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree, type AiTree, type RuleFile, type KnowledgeFile } from '../loader';
import { loadConfig, type MapperConfig } from '../config';
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
  test('writes CLAUDE.md, AGENTS.md, and .agents/AGENTS.md', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    expect(claude).toContain('fixture-repo');
    expect(agents).toContain('fixture-repo');
    expect(agentAgents).toContain('fixture-repo');

    const paths = mani
      .files()
      .map((f) => f.path)
      .toSorted();
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('.agents/AGENTS.md');
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
    expect(claude).not.toContain('## Project rules');
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
    expect(agents).not.toContain('## Project rules');
    expect(agents).not.toContain('Rule 2');
    expect(agents).toContain('.codex/rules/*.md');
    expect(agents).toContain('.cursor/rules/*.mdc');
    expect(agents).toContain('.codex/knowledge/*.md');
    expect(agents).toContain('.cursor/knowledge/*.md');
  });

  test('.agents/AGENTS.md has Antigravity orchestration section and no Project rules', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    expect(agentAgents).toContain('Your orchestration (Antigravity)');
    expect(agentAgents).toContain('Repository structure');
    expect(agentAgents).toContain('Domain knowledge index');
    expect(agentAgents).not.toContain('## Project rules');
    expect(agentAgents).not.toContain('Rule 2');
    expect(agentAgents).toContain('.agents/rules/*.md');
    expect(agentAgents).toContain('.agents/knowledge/*.md');
    expect(agentAgents).toContain('auto-loads');
  });

  test('all 3 files have the file tree section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).toContain('## Repository structure');
    }
  });

  test('all 3 files start with the project preamble', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
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
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    expect(
      await lstat(join(repo, 'CLAUDE.md'))
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await lstat(join(repo, '.agents/AGENTS.md'))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test('none of the 3 docs contain inline rule content', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).not.toContain('## Project rules');
    }
  });

  test('none of the 3 docs inline the knowledge bodies (lean root contract)', async () => {
    // The fixture's knowledge files contain known body strings that MUST NOT
    // appear in the root docs anymore — root docs only carry the index, not
    // the bodies.
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).not.toContain('Key fact from k1.');
      expect(doc).not.toContain('Demonstrates that the mapper picks up');
    }
  });

  test('all 3 docs contain the Extending the AI memory section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).toContain('## Extending the AI memory');
      expect(doc).toContain('enhance the `ai/` source folder');
      expect(doc).toContain('bun run ai/mapper/index.ts');
      expect(doc).toContain('Never edit files inside `.<tool>/` directly');
    }
  });

  test('all 3 docs include a knowledge index pointing at on-disk paths', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    // Each doc's index uses its own tool dir as the path prefix.
    expect(claude).toContain('## Domain knowledge index');
    expect(claude).toContain('| Path | Topic |');
    expect(claude).toContain('`.claude/knowledge/k1.md`');
    expect(claude).toContain('`.claude/knowledge/arch.md`');
    expect(claude).toContain('`.claude/knowledge/area/nested-knowledge.md`');

    // AGENTS.md uses .codex/ as the canonical (mirrored to .cursor/).
    expect(agents).toContain('`.codex/knowledge/k1.md`');

    expect(agentAgents).toContain('`.agents/knowledge/k1.md`');
  });

  test('index extracts the H1 as the topic description, falling back to basename', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    // k1.md starts with `# k1`, arch.md with `# Arch`. The H1 marker is stripped.
    expect(claude).toMatch(/`\.claude\/knowledge\/k1\.md`\s+|\s+k1\s/);
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

  test('when docs/ does not exist, none of the 3 docs contain Project documentation section', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).not.toContain('## Project documentation');
    }
  });

  test('when docs/ exists at repo root, all 3 docs contain Project documentation section', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'README.md'), '# Docs placeholder\n');

    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    for (const doc of [claude, agents, agentAgents]) {
      expect(doc).toContain('## Project documentation');
      expect(doc).toContain('Read `docs/` at the repo root');
    }
  });

  test('all 3 files contain the new rendered verbose Rules Index Table pointing to relative paths with metadata', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    const agentAgents = await readFile(join(repo, '.agents/AGENTS.md'), 'utf8');

    // 1. Check CLAUDE.md rules index table
    expect(claude).toContain('## 📜 Project Rules Index');
    expect(claude).toContain(
      '| Rule | Description | Trigger Scenarios (When to Apply) | Activation Type |',
    );
    expect(claude).toContain(
      '| [`Test Rule`](.claude/rules/scoped.md) | - Scoped rule. | Manual reference / Always-applied invariant | `Path-Scoped` |',
    );
    expect(claude).toContain(
      '| [`_always`](.claude/rules/_always.md) | - Rule 1. | Manual reference / Always-applied invariant | `Always-Applied` |',
    );
    expect(claude).toContain(
      '| [`nested-rule`](.claude/rules/auth/nested-rule.md) | Nested Rule | Manual reference / Always-applied invariant | `Always-Applied` |',
    );

    // 2. Check AGENTS.md rules index table (since Codex is enabled by default in minimal-ai mapper.config.toml)
    expect(agents).toContain('## 📜 Project Rules Index');
    expect(agents).toContain(
      '| [`Test Rule`](.codex/rules/scoped.md) | - Scoped rule. | Manual reference / Always-applied invariant | `Path-Scoped` |',
    );
    expect(agents).toContain('| [`nested-rule`](.codex/rules/auth/nested-rule.md) | Nested Rule |');

    // 3. Check .agents/AGENTS.md rules index table (Antigravity index uses relative rules/)
    expect(agentAgents).toContain('## 📜 Project Rules Index');
    expect(agentAgents).toContain(
      '| [`Test Rule`](rules/scoped.md) | - Scoped rule. | Manual reference / Always-applied invariant | `Path-Scoped` |',
    );
    expect(agentAgents).toContain('| [`nested-rule`](rules/auth/nested-rule.md) | Nested Rule |');
  });

  test('AGENTS.md rules index table uses .cursor relative paths if codex is disabled', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.codex = false;
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const agents = await readFile(join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('## 📜 Project Rules Index');
    expect(agents).toContain(
      '| [`Test Rule`](.cursor/rules/scoped.mdc) | - Scoped rule. | Manual reference / Always-applied invariant | `Path-Scoped` |',
    );
    expect(agents).toContain(
      '| [`nested-rule`](.cursor/rules/auth-nested-rule.mdc) | Nested Rule |',
    );
  });

  function makeRule(over: Partial<RuleFile>): RuleFile {
    return {
      path: `rules/${over.subpath ?? over.basename ?? 'rule'}.md`,
      basename: over.basename ?? 'rule',
      subpath: over.subpath ?? over.basename ?? 'rule',
      frontmatter: over.frontmatter ?? {},
      body: over.body ?? '# Body',
    };
  }

  function makeKnowledge(over: Partial<KnowledgeFile>): KnowledgeFile {
    return {
      path: `knowledge/${over.subpath ?? over.basename ?? 'k'}.md`,
      basename: over.basename ?? 'k',
      subpath: over.subpath ?? over.basename ?? 'k',
      body: over.body ?? '# K',
    };
  }

  function claudeOnlyConfig(): MapperConfig {
    return {
      schemaVersion: 1,
      tools: { claude: true, codex: false, cursor: false, antigravity: false },
      paths: {
        claudeDir: '.claude',
        cursorDir: '.cursor',
        codexDir: '.codex',
        antigravityDir: '.agents',
      },
      emitTools: { excludeSubdirs: [] },
    };
  }

  function treeWith(rules: RuleFile[], knowledge: KnowledgeFile[]): AiTree {
    return {
      preamble: '# fixture-repo\n',
      rules,
      knowledge,
      workflows: [],
      skills: [],
      agents: [],
      tools: { rootDir: join(repo, 'tools') },
    };
  }

  test('generateFileTree renders the repo file tree on the git success path', async () => {
    const git = Bun.which('git');
    expect(git).not.toBeNull();
    if (!git) return;

    const gitRepo = join(tmpdir(), `ai-emit-git-${Date.now()}-${Math.random()}`);
    await mkdir(join(gitRepo, 'alpha', 'beta'), { recursive: true });
    await writeFile(join(gitRepo, 'alpha', 'top.txt'), 'top\n');
    await writeFile(join(gitRepo, 'alpha', 'beta', 'leaf.txt'), 'leaf\n');

    const init = Bun.spawn([git, 'init'], { cwd: gitRepo, stdout: 'pipe', stderr: 'pipe' });
    await init.exited;
    const add = Bun.spawn([git, 'add', '-A'], { cwd: gitRepo, stdout: 'pipe', stderr: 'pipe' });
    await add.exited;

    const tree = treeWith([], []);
    const cfg = claudeOnlyConfig();
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani, gitRepo);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain(`${basename(gitRepo)}/`);
    expect(claude).toContain('alpha/');
    expect(claude).toContain('beta/');
    expect(claude).not.toContain('file tree unavailable');

    await rm(gitRepo, { recursive: true, force: true });
  });

  test('knowledge index row falls back to basename when the body is only whitespace', async () => {
    const tree = treeWith(
      [],
      [makeKnowledge({ basename: 'empty-body', subpath: 'empty-body', body: '   \n\n   ' })],
    );
    const cfg = claudeOnlyConfig();
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('| `.claude/knowledge/empty-body.md` | empty-body |');
  });

  test('rules index marks lazy-load activation as On-Demand', async () => {
    const tree = treeWith(
      [makeRule({ basename: 'lazy', subpath: 'lazy', frontmatter: { activation: 'lazy-load' } })],
      [],
    );
    const cfg = claudeOnlyConfig();
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude).toMatch(/\[`lazy`\]\(\.claude\/rules\/lazy\.md\).*`On-Demand`/);
  });

  test('rules index renders array scenarios as bulleted list and string scenarios verbatim', async () => {
    const tree = treeWith(
      [
        makeRule({
          basename: 'arr-scen',
          subpath: 'arr-scen',
          frontmatter: { scenarios: ['First case', 'Second case'] },
        }),
        makeRule({
          basename: 'str-scen',
          subpath: 'str-scen',
          frontmatter: { scenarios: 'A plain string scenario' },
        }),
      ],
      [],
    );
    const cfg = claudeOnlyConfig();
    const mani = new Manifest(repo);
    await emitRoot(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('• First case<br>• Second case');
    expect(claude).toContain('A plain string scenario');
  });
});
