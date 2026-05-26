import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitKnowledge } from '../emitters/knowledge';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-knowledge-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitKnowledge', () => {
  test('emits each knowledge file verbatim into every enabled tool dir', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitKnowledge(repo, tree, cfg, mani);

    for (const dir of [
      '.claude/knowledge',
      '.codex/knowledge',
      '.cursor/knowledge',
      '.gemini/knowledge',
      '.agent/knowledge',
    ]) {
      const k1 = await readFile(join(repo, dir, 'k1.md'), 'utf8');
      expect(k1).toContain('# k1');
      expect(k1).toContain('Key fact from k1.');
      expect(k1).not.toContain('---'); // no frontmatter wrapping
    }
  });

  test('preserves nested subpaths under <tool>/knowledge/', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitKnowledge(repo, tree, cfg, mani);

    for (const dir of [
      '.claude/knowledge',
      '.codex/knowledge',
      '.cursor/knowledge',
      '.gemini/knowledge',
      '.agent/knowledge',
    ]) {
      const nested = await readFile(join(repo, dir, 'area/nested-knowledge.md'), 'utf8');
      expect(nested).toContain('# Nested Knowledge');
      expect(nested).toContain('Demonstrates that the mapper picks up');
    }
  });

  test('records every emitted file in the manifest for safe-wipe', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitKnowledge(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    // Two files × five tools = 10 entries (k1, arch, area/nested-knowledge per tool).
    expect(paths).toContain('.claude/knowledge/k1.md');
    expect(paths).toContain('.claude/knowledge/arch.md');
    expect(paths).toContain('.claude/knowledge/area/nested-knowledge.md');
    expect(paths).toContain('.codex/knowledge/k1.md');
    expect(paths).toContain('.codex/knowledge/area/nested-knowledge.md');
    expect(paths).toContain('.cursor/knowledge/k1.md');
    expect(paths).toContain('.cursor/knowledge/area/nested-knowledge.md');
    expect(paths).toContain('.gemini/knowledge/k1.md');
    expect(paths).toContain('.gemini/knowledge/area/nested-knowledge.md');
    expect(paths).toContain('.agent/knowledge/k1.md');
    expect(paths).toContain('.agent/knowledge/area/nested-knowledge.md');
  });

  test('disabled tools are skipped entirely', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.cursor = false;
    cfg.tools.codex = false;
    cfg.tools.gemini = false;
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitKnowledge(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    expect(paths.every((p) => p.startsWith('.claude/knowledge/'))).toBe(true);

    for (const dir of [
      '.cursor/knowledge',
      '.codex/knowledge',
      '.gemini/knowledge',
      '.agent/knowledge',
    ]) {
      expect(
        await lstat(join(repo, dir))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    }
  });

  test('body is trimmed and ends with a single trailing newline', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitKnowledge(repo, tree, cfg, mani);

    const k1 = await readFile(join(repo, '.claude/knowledge/k1.md'), 'utf8');
    expect(k1.endsWith('\n')).toBe(true);
    expect(k1.endsWith('\n\n')).toBe(false);
  });

  test('emits zero files when ai/knowledge is empty', async () => {
    // Synthesize a tree with no knowledge items.
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const emptyTree = { ...tree, knowledge: [] };
    const mani = new Manifest(repo);
    await emitKnowledge(repo, emptyTree, cfg, mani);

    expect(mani.files().length).toBe(0);
  });
});
