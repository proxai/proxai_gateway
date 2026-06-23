// src/services/exclusion/tests/load.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRecursive } from 'core/io/fs';
import type { MinimalLogger } from 'core/log';
import { loadExcludedProjects } from 'services/exclusion/load.ts';

let dir: string;
let cfg: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-exclude-'));
  cfg = join(dir, 'config.toml');
});
afterEach(async () => {
  await rmRecursive(dir);
});

function collectWarnings(sink: string[]): MinimalLogger {
  const logger: MinimalLogger = {
    warn: (o: unknown) => {
      const obj = o as { line?: string; event?: string };
      if (typeof obj.line === 'string') sink.push(obj.line);
      else if (typeof obj.event === 'string') sink.push(obj.event);
    },
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => logger,
  };
  return logger;
}

test('missing config file returns the fallback (fail-safe, not [])', async () => {
  expect(await loadExcludedProjects(cfg, ['/fallback'])).toEqual(['/fallback']);
  expect(await loadExcludedProjects(cfg)).toEqual([]); // default fallback is []
});

test('reads + trims capture.excluded_projects', async () => {
  await writeFile(cfg, '[capture]\nexcluded_projects = ["  /Users/me/a  ", "~/b"]\n');
  expect(await loadExcludedProjects(cfg, ['/fallback'])).toEqual(['/Users/me/a', '~/b']);
});

test('unparseable TOML returns the fallback and warns', async () => {
  const warnings: string[] = [];
  await writeFile(cfg, 'this is = = not toml');
  expect(await loadExcludedProjects(cfg, ['/keep'], collectWarnings(warnings))).toEqual(['/keep']);
  expect(warnings).toContain('exclusion.config_read_failed');
});

test('parsed config with no [capture] or non-array yields [] (not fallback)', async () => {
  await writeFile(cfg, '[logging]\nlevel = "info"\n');
  expect(await loadExcludedProjects(cfg, ['/keep'])).toEqual([]);
  await writeFile(cfg, '[capture]\nexcluded_projects = "x"\n');
  expect(await loadExcludedProjects(cfg, ['/keep'])).toEqual([]);
});

test('skips non-string, empty, and relative entries (relative is logged)', async () => {
  const warnings: string[] = [];
  await writeFile(cfg, '[capture]\nexcluded_projects = ["/Users/me/ok", "  ", "relative/x", 3]\n');
  expect(await loadExcludedProjects(cfg, [], collectWarnings(warnings))).toEqual(['/Users/me/ok']);
  expect(warnings).toContain('relative/x');
});
