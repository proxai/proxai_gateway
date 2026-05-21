import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractRolloutCliVersion } from 'sources/codex/rollout-version.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-rollout-version-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

async function writeFirstLine(content: string): Promise<string> {
  const path = join(dir, 'rollout.jsonl');
  await writeFile(path, content);
  return path;
}

const failingReader = async (): Promise<string> => {
  throw new Error('disk error');
};

test('extracts cli_version from session_meta first line', async () => {
  const path = await writeFirstLine(
    `{"timestamp":"2026-05-08T07:51:29.550Z","type":"session_meta","payload":{"id":"abc","cli_version":"0.129.0-alpha.15"}}\n{"type":"event"}\n`,
  );
  expect(await extractRolloutCliVersion(path)).toBe('0.129.0-alpha.15');
});

test('returns null when first line is malformed JSON', async () => {
  const path = await writeFirstLine(`not json at all\n{"type":"event"}\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when first line lacks payload.cli_version', async () => {
  const path = await writeFirstLine(
    `{"timestamp":"x","type":"session_meta","payload":{"id":"abc"}}\n`,
  );
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when cli_version fails the validation regex', async () => {
  const path = await writeFirstLine(
    `{"type":"session_meta","payload":{"cli_version":"has space here"}}\n`,
  );
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when file is empty', async () => {
  const path = await writeFirstLine('');
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when payload is not an object', async () => {
  const path = await writeFirstLine(`{"type":"session_meta","payload":"oops"}\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when top-level is not an object', async () => {
  const path = await writeFirstLine(`["array","at","top"]\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when cli_version is not a string', async () => {
  const path = await writeFirstLine(`{"type":"session_meta","payload":{"cli_version":42}}\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('handles file with no trailing newline on first line', async () => {
  const path = await writeFirstLine(`{"type":"session_meta","payload":{"cli_version":"1.0.0"}}`);
  expect(await extractRolloutCliVersion(path)).toBe('1.0.0');
});

test('returns null when reader throws', async () => {
  expect(await extractRolloutCliVersion('/nonexistent', failingReader)).toBeNull();
});

test('uses injected reader for the head bytes', async () => {
  const calls: Array<{ path: string; length: number }> = [];
  const fakeReader = async (p: string, n: number): Promise<string> => {
    calls.push({ path: p, length: n });
    return `{"type":"session_meta","payload":{"cli_version":"9.9.9"}}\n`;
  };
  expect(await extractRolloutCliVersion('/fake/path', fakeReader)).toBe('9.9.9');
  expect(calls).toEqual([{ path: '/fake/path', length: 1_048_576 }]);
});

test('extracts cli_version from a ~22 KB session_meta first line', async () => {
  const padding = 'x'.repeat(22 * 1024);
  const path = await writeFirstLine(
    `{"type":"session_meta","payload":{"cli_version":"0.128.0-alpha.1","prompt":"${padding}"}}\n{"type":"event"}\n`,
  );
  expect(await extractRolloutCliVersion(path)).toBe('0.128.0-alpha.1');
});

test('returns null when first line exceeds the 1 MB head budget', async () => {
  const padding = 'x'.repeat(1_100_000);
  const path = await writeFirstLine(
    `{"type":"session_meta","payload":{"cli_version":"1.0.0","blob":"${padding}"}}\n`,
  );
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when payload is null', async () => {
  const path = await writeFirstLine(`{"type":"session_meta","payload":null}\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});

test('returns null when top-level JSON is null', async () => {
  const path = await writeFirstLine(`null\n`);
  expect(await extractRolloutCliVersion(path)).toBeNull();
});
