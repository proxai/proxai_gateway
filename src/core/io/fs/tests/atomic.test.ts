import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, writeAtomic } from 'core/io/fs';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-atomic-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('writeAtomic writes the file', async () => {
  const path = join(dir, 'a.txt');
  await writeAtomic(path, 'hello');
  expect(await Bun.file(path).text()).toBe('hello');
});

test('writeAtomic overwrites an existing file', async () => {
  const path = join(dir, 'b.txt');
  await writeAtomic(path, 'one');
  await writeAtomic(path, 'two');
  expect(await Bun.file(path).text()).toBe('two');
});

test('writeAtomic accepts Uint8Array', async () => {
  const path = join(dir, 'c.bin');
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  await writeAtomic(path, bytes);
  const got = new Uint8Array(await Bun.file(path).arrayBuffer());
  expect(got).toEqual(bytes);
});

test('writeAtomic does not leave behind .tmp orphans on success', async () => {
  const path = join(dir, 'd.txt');
  await writeAtomic(path, 'data');
  const files = await readdir(dir);
  const orphans = files.filter((f) => f.startsWith('d.txt.') && f.endsWith('.tmp'));
  expect(orphans).toEqual([]);
});

test('writeAtomic cleans up tmp and rethrows when rename fails', async () => {
  const targetDir = join(dir, 'is-a-dir');
  await mkdir(targetDir);
  await writeFile(join(targetDir, 'child'), 'child');

  await expect(writeAtomic(targetDir, 'data')).rejects.toThrow();

  const files = await readdir(dir);
  const orphans = files.filter((f) => f.startsWith('is-a-dir.') && f.endsWith('.tmp'));
  expect(orphans).toEqual([]);
});
