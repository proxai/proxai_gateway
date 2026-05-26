import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic, hashOf, copyDirRecursive, symlinkOrCopy } from '../safe-fs';

let tmp: string;
beforeEach(async () => {
  tmp = join(tmpdir(), `ai-dist-sfs-${Date.now()}-${Math.random()}`);
  await mkdir(tmp, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  test('creates parent dirs and writes content', async () => {
    const p = join(tmp, 'a/b/c.txt');
    await writeFileAtomic(p, 'hello');
    expect(await readFile(p, 'utf8')).toBe('hello');
  });
});

describe('hashOf', () => {
  test('identical input yields identical hash', () => {
    expect(hashOf('abc')).toBe(hashOf('abc'));
  });
  test('different input yields different hash', () => {
    expect(hashOf('abc')).not.toBe(hashOf('abd'));
  });
});

describe('copyDirRecursive', () => {
  test('copies a directory tree', async () => {
    const src = join(tmp, 'src');
    await mkdir(join(src, 'sub'), { recursive: true });
    await writeFile(join(src, 'a.txt'), 'A');
    await writeFile(join(src, 'sub/b.txt'), 'B');

    const dst = join(tmp, 'dst');
    const copied = await copyDirRecursive(src, dst);
    expect(copied.toSorted()).toEqual(['a.txt', 'sub/b.txt']);
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('A');
    expect(await readFile(join(dst, 'sub/b.txt'), 'utf8')).toBe('B');
  });
});

describe('symlinkOrCopy', () => {
  test('creates a symlink when mode=symlink', async () => {
    const target = join(tmp, 'target.txt');
    await writeFile(target, 'X');
    const linkPath = join(tmp, 'link.txt');
    await symlinkOrCopy('./target.txt', linkPath, 'symlink');
    const st = await stat(linkPath);
    expect(st.isFile()).toBe(true); // resolves through the symlink
    expect(await readFile(linkPath, 'utf8')).toBe('X');
  });

  test('copies content when mode=copy', async () => {
    const target = join(tmp, 'src.txt');
    await writeFile(target, 'Y');
    const dst = join(tmp, 'dst.txt');
    await symlinkOrCopy(target, dst, 'copy');
    expect(await readFile(dst, 'utf8')).toBe('Y');
  });
});
