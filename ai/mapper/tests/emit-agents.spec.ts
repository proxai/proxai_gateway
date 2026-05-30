import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, cp, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitAgents } from '../emitters/agents';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-ag-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
  await cp(FIXTURE, join(repo, 'ai'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitAgents', () => {
  test('passes through to Claude/Cursor and translates for Codex; skips Antigravity', async () => {
    const tree = await loadTree(join(repo, 'ai'));
    const cfg = await loadConfig(join(repo, 'ai'));
    const mani = new Manifest(repo);
    await emitAgents(repo, tree, cfg, mani);

    const claude = await readFile(join(repo, '.claude/agents/reviewer.md'), 'utf8');
    expect(claude).toContain('---');
    expect(claude).toContain('name: reviewer');
    expect(claude).toContain('You are a code reviewer.');

    const codex = await readFile(join(repo, '.codex/agents/reviewer.toml'), 'utf8');
    expect(codex).toContain('name = "reviewer"');
    expect(codex).toContain('tools = ["Read", "Grep"]');
    expect(codex).toContain('instructions = """');

    const paths = mani.files().map((f) => f.path);
    expect(paths).toContain('.claude/agents/reviewer.md');
    expect(paths).toContain('.codex/agents/reviewer.toml');
    expect(paths).toContain('.cursor/agents/reviewer.md');

    const antigravityExists = await lstat(join(repo, '.agents/agents/reviewer.md'))
      .then(() => true)
      .catch(() => false);
    expect(antigravityExists).toBe(false);
  });

  test('omits tools from Codex toml when frontmatter has no tools array', async () => {
    await writeFile(
      join(repo, 'ai/agents/notools.md'),
      '---\nname: notools\ndescription: No tools agent\n---\n\nNo tools here.\n',
    );
    const tree = await loadTree(join(repo, 'ai'));
    const cfg = await loadConfig(join(repo, 'ai'));
    const mani = new Manifest(repo);
    await emitAgents(repo, tree, cfg, mani);

    const codex = await readFile(join(repo, '.codex/agents/notools.toml'), 'utf8');
    expect(codex).toContain('name = "notools"');
    expect(codex).not.toContain('tools = ');
  });
});
