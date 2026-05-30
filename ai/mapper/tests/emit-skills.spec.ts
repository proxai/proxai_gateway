import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as realFsPromises from 'node:fs/promises';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitSkills } from '../emitters/skills';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

const realFsSnapshot = { ...realFsPromises };
let readFileShouldThrow = false;
mock.module('node:fs/promises', () => ({
  ...realFsSnapshot,
  readFile: (...args: Parameters<typeof realFsSnapshot.readFile>) =>
    readFileShouldThrow ? Promise.reject(new Error('boom')) : realFsSnapshot.readFile(...args),
}));

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-skills-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitSkills', () => {
  test("copies each skill folder to each enabled tool's skills dir", async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);
    await emitSkills(repo, tree, cfg, mani);

    for (const dir of ['.claude', '.cursor', '.agents']) {
      const md = await readFile(join(repo, dir, 'skills/sample-skill/SKILL.md'), 'utf8');
      expect(md).toContain('sample-skill');
    }

    const codexMd = await readFile(join(repo, '.agents/skills/sample-skill/SKILL.md'), 'utf8');
    expect(codexMd).toContain('sample-skill');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/skills/sample-skill/SKILL.md');
    expect(paths).toContain('.cursor/skills/sample-skill/SKILL.md');
    expect(paths).toContain('.agents/skills/sample-skill/SKILL.md');
  });

  test('disabled tools are skipped', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    cfg.tools.codex = false;
    cfg.tools.antigravity = false;
    const mani = new Manifest(repo);
    await emitSkills(repo, tree, cfg, mani);
    const paths = mani.files().map((f) => f.path);
    expect(paths.some((p) => p.startsWith('.agents/'))).toBe(false);
  });

  test('completes when readFile rejects, hashing empty content', async () => {
    const tree = await loadTree(FIXTURE);
    const cfg = await loadConfig(FIXTURE);
    const mani = new Manifest(repo);

    readFileShouldThrow = true;
    await emitSkills(repo, tree, cfg, mani);

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/skills/sample-skill/SKILL.md');
  });
});

afterEach(() => {
  readFileShouldThrow = false;
});
