import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { loadDesktopCliSessionIds } from 'sources/claude-desktop';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-sidecar-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

function linuxEnv(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: dir };
}

async function writeSidecar(acct: string, org: string, name: string, body: string): Promise<void> {
  const path = join(dir, 'Claude', 'claude-code-sessions', acct, org, name);
  await Bun.write(path, body);
}

test('collects cliSessionId values from sidecar files at the pinned depth', async () => {
  await writeSidecar('acct1', 'org1', 'local_a.json', JSON.stringify({ cliSessionId: 'sess-1' }));
  await writeSidecar('acct1', 'org2', 'local_b.json', JSON.stringify({ cliSessionId: 'sess-2' }));

  const ids = await loadDesktopCliSessionIds('linux', linuxEnv());
  expect([...ids].toSorted()).toEqual(['sess-1', 'sess-2']);
});

test('returns an empty set when the sidecar directory is missing', async () => {
  const ids = await loadDesktopCliSessionIds('linux', linuxEnv());
  expect(ids.size).toBe(0);
});

test('skips files with malformed JSON', async () => {
  await writeSidecar('acct1', 'org1', 'local_good.json', JSON.stringify({ cliSessionId: 'good' }));
  await writeSidecar('acct1', 'org1', 'local_bad.json', '{not json');

  const ids = await loadDesktopCliSessionIds('linux', linuxEnv());
  expect([...ids]).toEqual(['good']);
});

test('skips files that lack a non-empty string cliSessionId', async () => {
  await writeSidecar('acct1', 'org1', 'local_empty.json', JSON.stringify({ cliSessionId: '' }));
  await writeSidecar('acct1', 'org1', 'local_num.json', JSON.stringify({ cliSessionId: 5 }));
  await writeSidecar('acct1', 'org1', 'local_none.json', JSON.stringify({ other: 'x' }));
  await writeSidecar('acct1', 'org1', 'local_arr.json', JSON.stringify(['not-an-object']));

  const ids = await loadDesktopCliSessionIds('linux', linuxEnv());
  expect(ids.size).toBe(0);
});

test('ignores files outside the pinned acct/org depth', async () => {
  const shallow = join(dir, 'Claude', 'claude-code-sessions', 'acct1', 'local_shallow.json');
  await Bun.write(shallow, JSON.stringify({ cliSessionId: 'shallow' }));

  const ids = await loadDesktopCliSessionIds('linux', linuxEnv());
  expect(ids.size).toBe(0);
});
