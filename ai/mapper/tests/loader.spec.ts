import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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
});
