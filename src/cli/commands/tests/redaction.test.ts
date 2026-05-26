import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRedactionList, runRedactionTest } from 'cli/commands/redaction.ts';
import { captureOutput } from 'cli/output.ts';
import { ALL_RULES, RULE_CATEGORIES } from 'services/redaction';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-redaction-cmd-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

async function seed(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

test('test: redacts an inline-pattern key in input file', async () => {
  const fakeKey = 'sk-' + 'a'.repeat(48);
  const filePath = await seed('input.txt', `key=${fakeKey} other=value`);
  const lines: string[] = [];
  const result = await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath },
  );
  expect(result.exitCode).toBe(0);
  expect(lines[0]).toContain('[REDACTED:');
  expect(lines[0]).not.toContain(fakeKey);
});

test('test: emits original content when nothing matches', async () => {
  const filePath = await seed('clean.txt', 'just a plain log file with no secrets');
  const lines: string[] = [];
  const result = await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath },
  );
  expect(result.exitCode).toBe(0);
  expect(lines[0]).toBe('just a plain log file with no secrets');
});

test('test: --show-rules prints rule hit summary', async () => {
  const fakeKey = 'sk-' + 'a'.repeat(48);
  const filePath = await seed('input.txt', `key=${fakeKey}`);
  const lines: string[] = [];
  await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath, showRules: true },
  );
  const joined = lines.join('\n');
  expect(joined).toContain('Rules matched:');
  expect(joined).toContain('--- redacted output ---');
});

test('test: --show-rules prints "no rules matched" when nothing fires', async () => {
  const filePath = await seed('clean.txt', 'no secrets here');
  const lines: string[] = [];
  await runRedactionTest(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { filePath, showRules: true },
  );
  expect(lines.join('\n')).toContain('(no rules matched)');
});

test('test: returns fileUnreadable when file is missing', async () => {
  const out = captureOutput();
  const result = await runRedactionTest(
    { output: out, emit: () => undefined },
    { filePath: join(dir, 'missing.txt') },
  );
  expect(result.exitCode).toBe(7);
  expect(out.lines.some((l) => l.msg.includes('file not found'))).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  'test: returns fileUnreadable when text() throws for an unreadable file',
  async () => {
    const filePath = await seed('locked.txt', 'secret content');

    await chmod(filePath, 0o000);
    const out = captureOutput();
    try {
      const result = await runRedactionTest({ output: out, emit: () => undefined }, { filePath });
      expect(result.exitCode).toBe(7);
      expect(out.lines.some((l) => l.msg.includes('failed to read file'))).toBe(true);
    } finally {
      await chmod(filePath, 0o644);
    }
  },
);

test('test: rule summary lists rule IDs sorted by hit count', async () => {
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

test('list: default emits every category and rule', () => {
  const lines: string[] = [];
  const result = runRedactionList({ output: captureOutput(), emit: (l) => lines.push(l) }, {});
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(lines.join('\n'));
  for (const cat of RULE_CATEGORIES) {
    expect(joined).toContain(cat.name);
  }
  expect(joined).toContain(`Total: ${ALL_RULES.length.toString()} rules`);
});

test('list: every rule shows id, description, pattern, replacement', () => {
  const lines: string[] = [];
  runRedactionList({ output: captureOutput(), emit: (l) => lines.push(l) }, {});
  const joined = stripAnsi(lines.join('\n'));
  const sampleRule = requireDefined(ALL_RULES[0]);
  expect(joined).toContain(sampleRule.id);
  expect(joined).toContain(sampleRule.description);
  expect(joined).toContain(sampleRule.pattern.toString());
  expect(joined).toContain(sampleRule.replacement);
  expect(joined).toContain('→');
});

test('list: --categories shows only category summaries', () => {
  const lines: string[] = [];
  runRedactionList({ output: captureOutput(), emit: (l) => lines.push(l) }, { categories: true });
  const joined = stripAnsi(lines.join('\n'));
  for (const cat of RULE_CATEGORIES) {
    expect(joined).toContain(cat.name);
    expect(joined).toContain(cat.description);
  }

  const firstPattern = requireDefined(ALL_RULES[0]).pattern.toString();
  expect(joined.includes(firstPattern)).toBe(false);
});

test('list: --category filters to one category', () => {
  const target = requireDefined(RULE_CATEGORIES[0]);
  const lines: string[] = [];
  const result = runRedactionList(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { category: target.name },
  );
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(lines.join('\n'));
  expect(joined).toContain(target.name);

  for (const other of RULE_CATEGORIES) {
    if (other.name === target.name) continue;
    expect(joined.includes(`${other.name}  (`)).toBe(false);
  }
});

test('list: --category with unknown name returns validationError', () => {
  const out = captureOutput();
  const result = runRedactionList(
    { output: out, emit: () => undefined },
    { category: 'definitely-not-a-real-category' },
  );
  expect(result.exitCode).toBe(2);
  expect(out.lines.some((l) => l.msg.includes('unknown category'))).toBe(true);
});

test('list: --json emits structured JSON with all categories and rules', () => {
  const lines: string[] = [];
  runRedactionList({ output: captureOutput(), emit: (l) => lines.push(l) }, { json: true });
  const parsed = JSON.parse(lines.join('\n'));
  expect(parsed.total_rules).toBe(ALL_RULES.length);
  expect(parsed.category_count).toBe(RULE_CATEGORIES.length);
  expect(parsed.categories).toHaveLength(RULE_CATEGORIES.length);
  expect(parsed.categories[0].rules.length).toBeGreaterThan(0);
  expect(parsed.categories[0].rules[0].id).toBeDefined();
  expect(parsed.categories[0].rules[0].pattern).toMatch(/^\//);
  expect(parsed.categories[0].rules[0].replacement).toContain('[REDACTED:');
});

test('list: --json --categories emits category summaries only (no rule arrays)', () => {
  const lines: string[] = [];
  runRedactionList(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { json: true, categories: true },
  );
  const parsed = JSON.parse(lines.join('\n'));
  expect(parsed.category_count).toBe(RULE_CATEGORIES.length);
  expect(parsed.categories[0].rule_count).toBeGreaterThan(0);
  expect(parsed.categories[0].rules).toBeUndefined();
});

test('list: --json --category filters to one category', () => {
  const target = requireDefined(RULE_CATEGORIES[0]);
  const lines: string[] = [];
  runRedactionList(
    { output: captureOutput(), emit: (l) => lines.push(l) },
    { json: true, category: target.name },
  );
  const parsed = JSON.parse(lines.join('\n'));
  expect(parsed.category_count).toBe(1);
  expect(parsed.categories[0].name).toBe(target.name);
});

test('list: stage field never appears in any output (JSON or pretty)', () => {
  const linesPretty: string[] = [];
  runRedactionList({ output: captureOutput(), emit: (l) => linesPretty.push(l) }, {});
  expect(linesPretty.join('\n').includes('stage')).toBe(false);

  const linesJson: string[] = [];
  runRedactionList({ output: captureOutput(), emit: (l) => linesJson.push(l) }, { json: true });
  const parsed = JSON.parse(linesJson.join('\n'));
  for (const cat of parsed.categories) {
    for (const rule of cat.rules) {
      expect(rule.stage).toBeUndefined();
    }
  }
});
