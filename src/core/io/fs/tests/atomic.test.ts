import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeAtomic } from 'core/io/fs';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-atomic-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
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
