// src/services/exclusion/tests/load.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRecursive } from 'core/io/fs';
import type { MinimalLogger } from 'core/log';
import { loadExcludedProjects } from 'services/exclusion/load.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-exclude-'));
});
afterEach(async () => {
  await rmRecursive(dir);
});

test('missing file yields empty list', async () => {
  expect(await loadExcludedProjects(dir)).toEqual([]);
});

test('parses absolute paths, skips comments and blank lines, trims whitespace', async () => {
  await writeFile(
    join(dir, 'excluded-projects'),
    '# header\n\n  /Users/me/a  \n/Users/me/b\n\t# indented comment\n~/c\n',
  );
  expect(await loadExcludedProjects(dir)).toEqual(['/Users/me/a', '/Users/me/b', '~/c']);
});

test('skips relative paths (does not silently treat them as literals)', async () => {
  const skipped: string[] = [];
  await writeFile(join(dir, 'excluded-projects'), 'projects/secret\n/Users/me/ok\nrelative\n');
  const warnLogger: MinimalLogger = {
    warn: (o: unknown) => {
      const obj = o as { line?: string };
      if (typeof obj.line === 'string') skipped.push(obj.line);
    },
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => warnLogger,
  };
  const result = await loadExcludedProjects(dir, warnLogger);
  expect(result).toEqual(['/Users/me/ok']);
  expect(skipped).toEqual(['projects/secret', 'relative']);
});
