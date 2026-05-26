import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manifest } from '../manifest';

let tmp: string;
beforeEach(async () => {
  tmp = join(tmpdir(), `ai-dist-mani-${Date.now()}-${Math.random()}`);
  await mkdir(tmp, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('Manifest', () => {
  test('tracks files as they are emitted', () => {
    const m = new Manifest(tmp);
    m.recordEmit('AGENTS.md', 'hash1');
    m.recordEmit('.claude/skills/x/SKILL.md', 'hash2');
    expect(m.files()).toEqual([
      { path: 'AGENTS.md', hash: 'hash1' },
      { path: '.claude/skills/x/SKILL.md', hash: 'hash2' },
    ]);
  });

  test('write/load roundtrip', async () => {
    const m1 = new Manifest(tmp);
    m1.recordEmit('AGENTS.md', 'hashA');
    await m1.save();

    const m2 = await Manifest.load(tmp);
    expect(m2.files()).toEqual([{ path: 'AGENTS.md', hash: 'hashA' }]);
  });

  test('load returns empty manifest when none exists', async () => {
    const m = await Manifest.load(tmp);
    expect(m.files()).toEqual([]);
  });

  test('sourceHash round-trips', async () => {
    const m1 = new Manifest(tmp);
    m1.recordEmit('AGENTS.md', 'hashA');
    m1.setSourceHash('abc123def');
    await m1.save();

    const m2 = await Manifest.load(tmp);
    expect(m2.sourceHash()).toBe('abc123def');
  });

  test('manifest written without sourceHash loads it as undefined (back-compat)', async () => {
    const m1 = new Manifest(tmp);
    m1.recordEmit('AGENTS.md', 'hashA');
    // do NOT call setSourceHash — simulates pre-feature manifests on disk
    await m1.save();

    const m2 = await Manifest.load(tmp);
    expect(m2.sourceHash()).toBeUndefined();
    // files still load fine
    expect(m2.files()).toEqual([{ path: 'AGENTS.md', hash: 'hashA' }]);
  });

  test('diff identifies stale files (in old manifest, not in new emit)', async () => {
    const old = new Manifest(tmp);
    old.recordEmit('a.md', '1');
    old.recordEmit('b.md', '2');
    await old.save();

    const fresh = new Manifest(tmp);
    fresh.recordEmit('a.md', '1'); // still emitted
    // b.md is NOT emitted this run

    const oldLoaded = await Manifest.load(tmp);
    const stale = fresh.diffStale(oldLoaded);
    expect(stale).toEqual(['b.md']);
  });
});
