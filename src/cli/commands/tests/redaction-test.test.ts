import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRedactionTest } from 'cli/commands/redaction-test.ts';
import { captureOutput } from 'cli/output.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-redaction-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

test('redacts an OpenAI-shaped key in input file', async () => {
  const fakeKey = 'sk-' + 'a'.repeat(48);
  const filePath = await seed('input.txt', `key=${fakeKey} other=value`);
  const lines: string[] = [];
  const result = await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath },
  );
  expect(result.exitCode).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('[REDACTED:');
  expect(lines[0]).not.toContain(fakeKey);
});

test('emits original content when nothing matches', async () => {
  const filePath = await seed('clean.txt', 'just a plain log file with no secrets');
  const lines: string[] = [];
  const result = await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath },
  );
  expect(result.exitCode).toBe(0);
  expect(lines[0]).toBe('just a plain log file with no secrets');
});

test('--show-rules prints rule hit summary', async () => {
  const fakeKey = 'sk-' + 'a'.repeat(48);
  const filePath = await seed('input.txt', `key=${fakeKey}`);
  const lines: string[] = [];
  const result = await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath, showRules: true },
  );
  expect(result.exitCode).toBe(0);
  const joined = lines.join('\n');
  expect(joined).toContain('Rules matched:');
  expect(joined).toContain('--- redacted output ---');
});

test('--show-rules prints "no rules matched" when nothing fires at a stage', async () => {
  const filePath = await seed('clean.txt', 'no secrets here');
  const lines: string[] = [];
  await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath, showRules: true },
  );
  const joined = lines.join('\n');
  expect(joined).toContain('(no rules matched)');
});

test('returns fileUnreadable exit code when file is missing', async () => {
  const out = captureOutput();
  const result = await runRedactionTest(
    { output: out, emit: () => undefined },
    { filePath: join(dir, 'missing.txt') },
  );
  expect(result.exitCode).toBe(7);
  expect(out.lines.some((l) => l.msg.includes('file not found'))).toBe(true);
});

test('redacts Stage 2 keyword-anchored secrets', async () => {
  const filePath = await seed('travis.txt', 'TRAVIS_TOKEN=AbCdEfGhIjKlMnOpQrStUv');
  const lines: string[] = [];
  await runRedactionTest({ output: captureOutput(), emit: (l) => lines.push(l) }, { filePath });
  expect(lines[0]).toContain('[REDACTED:travis-ci-token]');
});

test('rule summary lists rule IDs sorted by hit count', async () => {
  const k = 'sk-' + 'b'.repeat(48);
  const filePath = await seed('multi.txt', `${k}\n${k}\n${k}\nTRAVIS_TOKEN=AbCdEfGhIjKlMnOpQrStUv`);
  const lines: string[] = [];
  await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath, showRules: true },
  );
  const joined = lines.join('\n');
  expect(joined).toMatch(/openai-api-key: 3/);
  expect(joined).toMatch(/travis-ci-token: 1/);
});
