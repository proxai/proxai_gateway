import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJsonlRange } from 'core/io/jsonl';

const decoder = new TextDecoder();

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-jsonl-reader-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

test('reads complete lines and reports advanced end byte', async () => {
  const path = join(dir, 'a.jsonl');
  const content = '{"a":1}\n{"b":2}\n';
  await Bun.write(path, content);
  const r = await readJsonlRange(path, 0, content.length);
  expect(decoder.decode(r.bytes)).toBe(content);
  expect(r.endByte).toBe(content.length);
  expect(r.partialTail.byteLength).toBe(0);
});

test('holds back trailing partial line', async () => {
  const path = join(dir, 'b.jsonl');
  const content = '{"a":1}\n{"b":2';
  await Bun.write(path, content);
  const r = await readJsonlRange(path, 0, content.length);
  expect(decoder.decode(r.bytes)).toBe('{"a":1}\n');
  expect(r.endByte).toBe('{"a":1}\n'.length);
  expect(decoder.decode(r.partialTail)).toBe('{"b":2');
});

test('returns empty range when no newline is present', async () => {
  const path = join(dir, 'c.jsonl');
  const content = '{"a":1';
  await Bun.write(path, content);
  const r = await readJsonlRange(path, 0, content.length);
  expect(r.bytes.byteLength).toBe(0);
  expect(r.endByte).toBe(0);
  expect(decoder.decode(r.partialTail)).toBe(content);
});

test('reads only the requested window', async () => {
  const path = join(dir, 'd.jsonl');
  const content = '{"a":1}\n{"b":2}\n{"c":3}\n';
  await Bun.write(path, content);
  const r = await readJsonlRange(path, 8, 16);
  expect(decoder.decode(r.bytes)).toBe('{"b":2}\n');
  expect(r.endByte).toBe(16);
});

test('returns empty range when end <= start', async () => {
  const path = join(dir, 'e.jsonl');
  await Bun.write(path, '{"a":1}\n');
  const r = await readJsonlRange(path, 5, 5);
  expect(r.bytes.byteLength).toBe(0);
  expect(r.endByte).toBe(5);
  expect(r.partialTail.byteLength).toBe(0);
});
