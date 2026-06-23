import { beforeEach, expect, test } from 'bun:test';
import type { GatewayConfig } from 'services/config';
import { runExclude } from 'cli/commands/exclude/exclude.ts';

function makeConfig(excluded: string[]): GatewayConfig {
  return {
    account: {
      apiKey: 'k',
      userId: 'u',
      hostId: 'h',
      installedAt: 't',
      installSource: 'github_release',
    },
    backend: { ingestUrl: 'u', verifyKeyUrl: 'u', watermarksUrl: 'u', registerHostIdUrl: 'u' },
    capture: {
      pollIntervalSec: 300,
      bufferPath: '/tmp/b.db',
      receiptRetentionDays: 1,
      failedRetentionDays: 1,
      bufferSoftPauseBytes: 2,
      bufferSoftResumeBytes: 1,
      uploadMaxBatchesPerSec: 1,
      uploadMaxBytesPerMinute: 1,
      uploadBackoffOn429Multiplier: 1,
      excludedProjects: excluded,
    },
    logging: { level: 'info', logDir: '/tmp/logs' },
    staleBinary: { warnAfterDays: 1, pauseAfterDays: 1 },
  };
}

let written: GatewayConfig | null;
let lines: string[];
function deps(config: GatewayConfig | Error) {
  written = null;
  lines = [];
  return {
    loadConfig: async () => {
      if (config instanceof Error) throw config;
      return config;
    },
    writeConfig: async (c: GatewayConfig) => {
      written = c;
    },
    print: (line: string) => lines.push(line),
  };
}
beforeEach(() => {
  written = null;
  lines = [];
});

test('add appends a new path and writes', async () => {
  const r = await runExclude(deps(makeConfig([])), { kind: 'add', path: '/Users/me/p' });
  expect(r.exitCode).toBe(0);
  expect(written?.capture.excludedProjects).toEqual(['/Users/me/p']);
  expect(lines.join('\n')).toContain('Excluded /Users/me/p');
});
test('add is idempotent on the canonical key (no duplicate, no write)', async () => {
  const r = await runExclude(deps(makeConfig(['/Users/me/p/'])), {
    kind: 'add',
    path: '/Users/me/p',
  });
  expect(r.exitCode).toBe(0);
  expect(written).toBeNull();
  expect(lines.join('\n')).toContain('Already excluded');
});
test('add rejects a relative path without writing', async () => {
  const r = await runExclude(deps(makeConfig([])), { kind: 'add', path: 'relative/x' });
  expect(r.exitCode).toBe(1);
  expect(written).toBeNull();
  expect(lines.join('\n')).toContain('Invalid path');
});
test('add rejects a ~user path (only ~ and ~/ are supported)', async () => {
  const r = await runExclude(deps(makeConfig([])), { kind: 'add', path: '~bob/p' });
  expect(r.exitCode).toBe(1);
  expect(written).toBeNull();
});
test('remove drops a matching path and writes', async () => {
  const r = await runExclude(deps(makeConfig(['/Users/me/p'])), {
    kind: 'remove',
    path: '/Users/me/p',
  });
  expect(r.exitCode).toBe(0);
  expect(written?.capture.excludedProjects).toEqual([]);
  expect(lines.join('\n')).toContain('Un-excluded');
});
test('remove of an absent path does not write', async () => {
  const r = await runExclude(deps(makeConfig(['/Users/me/p'])), {
    kind: 'remove',
    path: '/Users/me/other',
  });
  expect(r.exitCode).toBe(0);
  expect(written).toBeNull();
  expect(lines.join('\n')).toContain('Not in the exclusion list');
});
test('remove rejects a relative path', async () => {
  const r = await runExclude(deps(makeConfig([])), { kind: 'remove', path: 'rel' });
  expect(r.exitCode).toBe(1);
  expect(written).toBeNull();
});
test('list with entries prints each path', async () => {
  const r = await runExclude(deps(makeConfig(['/a', '/b'])), { kind: 'list' });
  expect(r.exitCode).toBe(0);
  expect(lines).toEqual(['/a', '/b']);
});
test('list with no entries prints a friendly message', async () => {
  const r = await runExclude(deps(makeConfig([])), { kind: 'list' });
  expect(r.exitCode).toBe(0);
  expect(lines.join('\n')).toContain('No excluded projects');
});
test('missing config is reported with exit code 1', async () => {
  const r = await runExclude(deps(new Error('config file not found')), { kind: 'list' });
  expect(r.exitCode).toBe(1);
  expect(lines.join('\n')).toContain('setup');
});
test('a write failure is reported cleanly with exit code 1 (does not throw)', async () => {
  const out: string[] = [];
  const failingDeps = {
    loadConfig: async () => makeConfig([]),
    writeConfig: async () => {
      throw new Error('EACCES');
    },
    print: (l: string) => out.push(l),
  };
  const r = await runExclude(failingDeps, { kind: 'add', path: '/Users/me/p' });
  expect(r.exitCode).toBe(1);
  expect(out.join('\n')).toContain('Failed to update the configuration');
  expect(out.join('\n')).toContain('EACCES');
});
test('list annotates a hand-edited non-absolute entry as ignored', async () => {
  const r = await runExclude(deps(makeConfig(['/Users/me/ok', 'relative/x'])), { kind: 'list' });
  expect(r.exitCode).toBe(0);
  expect(lines).toEqual(['/Users/me/ok', 'relative/x  (ignored — not an absolute or ~/ path)']);
});
