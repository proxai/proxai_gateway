import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTree } from '../loader';
import { loadConfig } from '../config';
import { emitWorkflows } from '../emitters/workflows';
import { Manifest } from '../manifest';

const FIXTURE = join(import.meta.dir, 'fixtures/minimal-ai');

let repo: string;
beforeEach(async () => {
  repo = join(tmpdir(), `ai-emit-wf-${Date.now()}-${Math.random()}`);
  await mkdir(repo, { recursive: true });
  await cp(FIXTURE, join(repo, 'ai'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('emitWorkflows', () => {
  test('Claude/Cursor get .md commands, Gemini gets .toml, Antigravity gets .md workflows, Codex skipped', async () => {
    const tree = await loadTree(join(repo, 'ai'));
    const cfg = await loadConfig(join(repo, 'ai'));
    const mani = new Manifest(repo);
    await emitWorkflows(repo, tree, cfg, mani);

    expect(await readFile(join(repo, '.claude/commands/audit.md'), 'utf8')).toContain('Audit');
    expect(await readFile(join(repo, '.cursor/commands/audit.md'), 'utf8')).toContain('Audit');
    expect(await readFile(join(repo, '.gemini/commands/audit.toml'), 'utf8')).toContain(
      'prompt = ',
    );
    expect(await readFile(join(repo, '.agent/workflows/audit.md'), 'utf8')).toContain('Audit');

    const codexPath = join(repo, '.codex/commands/audit.md');
    expect(
      await readFile(codexPath, 'utf8')
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });
});
