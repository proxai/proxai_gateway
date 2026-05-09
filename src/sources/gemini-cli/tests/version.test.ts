import { expect, test } from 'bun:test';

import { defaultSpawn, defaultWhich, detectGeminiCliVersion } from 'sources/gemini-cli/version.ts';

test('returns null when which returns null', async () => {
  const result = await detectGeminiCliVersion({
    which: () => null,
    spawn: async () => ({ stdout: 'should not be called', exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('returns version when which + spawn succeed with valid stdout', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2\n', exitCode: 0 }),
  });
  expect(result).toBe('0.41.2');
});

test('takes only the first line of stdout', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2\nbuilt 2026-05-08\n', exitCode: 0 }),
  });
  expect(result).toBe('0.41.2');
});

test('returns null when spawn exitCode is non-zero', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2\n', exitCode: 1 }),
  });
  expect(result).toBeNull();
});

test('returns null when stdout is empty', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '', exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('returns null when stdout is whitespace only', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '   \n  \n', exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('returns null when first line fails the version regex', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: 'version 0.41.2 (built 2026)\n', exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('returns null when version contains disallowed characters', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2;DROP TABLE\n', exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('returns null when spawn throws', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => {
      throw new Error('process spawn failed');
    },
  });
  expect(result).toBeNull();
});

test('accepts versions with valid namespacing characters', async () => {
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2-alpha.1+build.7\n', exitCode: 0 }),
  });
  expect(result).toBe('0.41.2-alpha.1+build.7');
});

test('rejects versions longer than 64 characters', async () => {
  const longVersion = 'a'.repeat(65);
  const result = await detectGeminiCliVersion({
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: `${longVersion}\n`, exitCode: 0 }),
  });
  expect(result).toBeNull();
});

test('default real-fs path returns null or a valid version (no fakes)', async () => {
  const result = await detectGeminiCliVersion();
  if (result !== null) {
    expect(result).toMatch(/^[\w.+:/-]{1,64}$/);
  } else {
    expect(result).toBeNull();
  }
});

test('defaultWhich resolves a known-present binary or returns null deterministically', () => {
  const lookup = process.platform === 'win32' ? 'cmd' : 'sh';
  const result = defaultWhich(lookup);
  if (result !== null) {
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  }
  expect(defaultWhich('__definitely_not_a_real_cmd_xyz__')).toBeNull();
});

test('defaultSpawn runs a portable command and returns stdout + exit code', async () => {
  const argv =
    process.platform === 'win32'
      ? ['cmd', '/c', 'echo', 'gemini-test-version']
      : ['/bin/sh', '-c', 'echo gemini-test-version'];
  const { stdout, exitCode } = await defaultSpawn(argv);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('gemini-test-version');
}, 10_000);
