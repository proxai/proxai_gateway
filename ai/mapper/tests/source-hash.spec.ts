import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeSourceHash, findFirstMissingEmit } from '../source-hash';

let aiRoot: string;
beforeEach(async () => {
  aiRoot = join(tmpdir(), `ai-source-hash-${Date.now()}-${Math.random()}`);
  await mkdir(join(aiRoot, 'rules'), { recursive: true });
  await writeFile(join(aiRoot, 'AGENTS.md'), '# Preamble\n');
  await writeFile(join(aiRoot, 'rules', 'r1.md'), '# Rule 1\n');
});
afterEach(async () => {
  await rm(aiRoot, { recursive: true, force: true });
});

describe('computeSourceHash', () => {
  test('is deterministic for identical trees', async () => {
    const a = await computeSourceHash(aiRoot);
    const b = await computeSourceHash(aiRoot);
    expect(a).toBe(b);
  });

  test('changes when a file body changes', async () => {
    const before = await computeSourceHash(aiRoot);
    await writeFile(join(aiRoot, 'rules', 'r1.md'), '# Rule 1 — edited\n');
    const after = await computeSourceHash(aiRoot);
    expect(after).not.toBe(before);
  });

  test('changes when a new file is added', async () => {
    const before = await computeSourceHash(aiRoot);
    await writeFile(join(aiRoot, 'rules', 'r2.md'), '# Rule 2\n');
    const after = await computeSourceHash(aiRoot);
    expect(after).not.toBe(before);
  });

  test('changes when a file is renamed (path is part of the hash)', async () => {
    const before = await computeSourceHash(aiRoot);
    await rm(join(aiRoot, 'rules', 'r1.md'));
    await writeFile(join(aiRoot, 'rules', 'renamed.md'), '# Rule 1\n');
    const after = await computeSourceHash(aiRoot);
    expect(after).not.toBe(before);
  });

  test('ignores dotfiles (mapper manifest, .DS_Store, etc.)', async () => {
    const before = await computeSourceHash(aiRoot);
    await writeFile(join(aiRoot, '.mapper-manifest.json'), '{"files":[],"sourceHash":"x"}\n');
    await writeFile(join(aiRoot, '.DS_Store'), 'mac garbage');
    const after = await computeSourceHash(aiRoot);
    expect(after).toBe(before);
  });

  test('throws cleanly when ai/ root is missing', async () => {
    await rm(aiRoot, { recursive: true, force: true });
    expect(computeSourceHash(aiRoot)).rejects.toThrow();
  });
});

describe('findFirstMissingEmit', () => {
  let repo: string;
  beforeEach(async () => {
    repo = join(tmpdir(), `ai-missing-${Date.now()}-${Math.random()}`);
    await mkdir(join(repo, '.claude', 'rules'), { recursive: true });
    await writeFile(join(repo, '.claude', 'rules', 'r1.md'), '# r1\n');
    await writeFile(join(repo, '.claude', 'rules', 'r2.md'), '# r2\n');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('returns null when every emitted path exists', async () => {
    const out = await findFirstMissingEmit(repo, ['.claude/rules/r1.md', '.claude/rules/r2.md']);
    expect(out).toBeNull();
  });

  test('returns the first missing path', async () => {
    await rm(join(repo, '.claude', 'rules', 'r1.md'));
    const out = await findFirstMissingEmit(repo, ['.claude/rules/r1.md', '.claude/rules/r2.md']);
    expect(out).toBe('.claude/rules/r1.md');
  });

  test('empty manifest returns null', async () => {
    const out = await findFirstMissingEmit(repo, []);
    expect(out).toBeNull();
  });
});
