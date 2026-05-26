import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitTools } from '../emitters/tools';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-tools-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitTools', () => {
  test("copies tools/ contents to each enabled tool's tools dir", async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitTools(repo, tree, cfg, mani);

    for (const dir of ['.claude', '.cursor', '.codex', '.gemini', '.agent']) {
      const sh = await readFile(join(repo, dir, 'tools/helper.sh'), 'utf8');
      expect(sh).toContain('helper tool');
    }

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/tools/helper.sh');
    expect(paths).toContain('.cursor/tools/helper.sh');
    expect(paths).toContain('.codex/tools/helper.sh');
    expect(paths).toContain('.gemini/tools/helper.sh');
    expect(paths).toContain('.agent/tools/helper.sh');
  });

  test('disabled tools are skipped', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.gemini = false;
    const mani = new Manifest(repo);
    await emitTools(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    expect(paths.some((p) => p.startsWith('.gemini/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(true);
  });

  test('silently skips when tools/ is absent', async () => {
    const tree = await loadTree(FIXTURE);
    tree.tools.rootDir = '/nonexistent/path/tools';
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitTools(repo, tree, cfg, mani);
    expect(mani.files().length).toBe(0);
  });

  test('emit_tools.exclude_subdirs skips named subdir for every tool', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.emitTools.excludeSubdirs = ['big-thing'];
    const mani = new Manifest(repo);
    await emitTools(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    // top-level files (helper.sh) still copy
    expect(paths).toContain('.claude/tools/helper.sh');
    expect(paths).toContain('.agent/tools/helper.sh');
    // excluded subdir is absent from every tool
    expect(paths.some((p) => p.includes('big-thing'))).toBe(false);
    for (const dir of ['.claude', '.cursor', '.codex', '.gemini', '.agent']) {
      const big = join(repo, dir, 'tools/big-thing/main.ts');
      expect(
        await readFile(big, 'utf8').then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
  });

  test('non-excluded subdirs copy recursively', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    // no exclusions — big-thing should appear with its nested file
    const mani = new Manifest(repo);
    await emitTools(repo, tree, cfg, mani);

    for (const dir of ['.claude', '.cursor', '.codex', '.gemini', '.agent']) {
      const main = await readFile(join(repo, dir, 'tools/big-thing/main.ts'), 'utf8');
      expect(main).toContain('noop');
      const inner = await readFile(join(repo, dir, 'tools/big-thing/sub/inner.ts'), 'utf8');
      expect(inner).toContain('inner');
    }
    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/tools/big-thing/main.ts');
    expect(paths).toContain('.claude/tools/big-thing/sub/inner.ts');
  });
});
