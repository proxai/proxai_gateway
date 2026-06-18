// src/services/exclusion/tests/head-cwd.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRecursive, statFile } from 'core/io/fs';
import { resolveCwdFromHead } from 'services/exclusion/head-cwd.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-headcwd-'));
});
afterEach(async () => {
  await rmRecursive(dir);
});

async function write(name: string, content: string): Promise<{ path: string; size: number }> {
  const path = join(dir, name);
  await writeFile(path, content);
  const stat = await statFile(path);
  return { path, size: stat.exists ? stat.size : 0 };
}

test('returns the first record top-level cwd (claude-code style: cwd on dialogue record)', async () => {
  const f = await write(
    'cc.jsonl',
    '{"type":"user","cwd":"/Users/me/proj","message":{"role":"user","content":"hi"}}\n',
  );
  expect(await resolveCwdFromHead(f.path, f.size)).toBe('/Users/me/proj');
});

test('returns cwd from a codex session_meta first line, skipping leading no-cwd records', async () => {
  const f = await write(
    'codex.jsonl',
    '{"type":"queue","cwd":null}\n{"type":"session_meta","cwd":"/Users/me/proj"}\n',
  );
  expect(await resolveCwdFromHead(f.path, f.size)).toBe('/Users/me/proj');
});

test('returns null when no record has a non-empty cwd', async () => {
  const f = await write('nocwd.jsonl', '{"type":"user","message":{"content":"hi"}}\n');
  expect(await resolveCwdFromHead(f.path, f.size)).toBeNull();
});

test('returns null for an empty/zero-byte file', async () => {
  const f = await write('empty.jsonl', '');
  expect(await resolveCwdFromHead(f.path, f.size)).toBeNull();
});

test('returns payload.cwd for the real Codex session_meta shape (cwd nested in payload)', async () => {
  const f = await write(
    'codex-real.jsonl',
    '{"type":"session_meta","payload":{"cwd":"/Users/me/proj","cli_version":"x"}}\n',
  );
  expect(await resolveCwdFromHead(f.path, f.size)).toBe('/Users/me/proj');
});

test('treats a whitespace-only cwd as no cwd (top-level and payload)', async () => {
  const top = await write('ws-top.jsonl', '{"type":"user","cwd":"   "}\n');
  expect(await resolveCwdFromHead(top.path, top.size)).toBeNull();
  const nested = await write(
    'ws-payload.jsonl',
    '{"type":"session_meta","payload":{"cwd":"   "}}\n',
  );
  expect(await resolveCwdFromHead(nested.path, nested.size)).toBeNull();
});
