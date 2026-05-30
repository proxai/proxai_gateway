import { describe, expect, test, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

describe('loadTree', () => {
  test('loads all artifact categories from a minimal fixture', async () => {
    const tree = await loadTree(FIXTURE);
    expect(tree.preamble).toContain('fixture-repo');
    // 2 flat rules + 1 nested under auth/
    expect(tree.rules.length).toBe(3);
    const always = tree.rules.find((r) => r.body.includes('Rule 1'));
    expect(always?.body).toContain('Rule 1');
    const scoped = tree.rules.find((r) => r.body.includes('Scoped rule'));
    expect(scoped?.body).toContain('Scoped rule');
    // 2 flat knowledge + 1 nested under area/
    expect(tree.knowledge.length).toBe(3);
    expect(tree.workflows.length).toBe(1);
    expect(tree.skills.length).toBe(1);
    expect(tree.skills[0].name).toBe('sample-skill');
    expect(tree.agents.length).toBe(1);
    expect(tree.agents[0].frontmatter.name).toBe('reviewer');
    expect(tree.tools.rootDir).toContain('tools');
  });

  test('rule subpath preserves subdir grouping', async () => {
    const tree = await loadTree(FIXTURE);
    const nested = tree.rules.find((r) => r.basename === 'nested-rule');
    expect(nested?.subpath).toBe('auth/nested-rule');
    const flat = tree.rules.find((r) => r.basename === '_always');
    expect(flat?.subpath).toBe('_always');
  });

  test('knowledge subpath preserves subdir grouping', async () => {
    const tree = await loadTree(FIXTURE);
    const nested = tree.knowledge.find((k) => k.basename === 'nested-knowledge');
    expect(nested?.subpath).toBe('area/nested-knowledge');
    const flat = tree.knowledge.find((k) => k.basename === 'k1');
    expect(flat?.subpath).toBe('k1');
  });

  test('missing optional folders yield empty arrays', async () => {
    const tree = await loadTree(FIXTURE);
    expect(Array.isArray(tree.rules)).toBe(true);
  });

  test('loadTree parses frontmatter from rules files', async () => {
    const tree = await loadTree(FIXTURE);
    const scoped = tree.rules.find((r) => r.basename === 'scoped');
    expect(scoped).toBeDefined();
    expect(scoped?.frontmatter).toEqual({
      name: 'Test Rule',
      activation: 'contextual',
      globs: ['src/**/*.ts'],
    });
    expect(scoped?.body.trim()).toBe('- Scoped rule.');
  });

  describe('with an ai/ root missing expected subdirectories', () => {
    let bareRoot: string;

    afterEach(async () => {
      if (bareRoot) await rm(bareRoot, { recursive: true, force: true });
    });

    test('listMd on absent dirs yields empty arrays', async () => {
      bareRoot = join(tmpdir(), `ai-loader-bare-${Date.now()}-${Math.random()}`);
      await mkdir(bareRoot, { recursive: true });

      const tree = await loadTree(bareRoot);
      expect(tree.preamble).toBe('');
      expect(tree.rules).toEqual([]);
      expect(tree.knowledge).toEqual([]);
      expect(tree.workflows).toEqual([]);
      expect(tree.skills).toEqual([]);
      expect(tree.agents).toEqual([]);
    });
  });

  test('skills are sorted by name', async () => {
    const root = join(tmpdir(), `ai-loader-skills-${Date.now()}-${Math.random()}`);
    await mkdir(join(root, 'skills', 'zebra-skill'), { recursive: true });
    await mkdir(join(root, 'skills', 'alpha-skill'), { recursive: true });
    try {
      const tree = await loadTree(root);
      expect(tree.skills.map((s) => s.name)).toEqual(['alpha-skill', 'zebra-skill']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
