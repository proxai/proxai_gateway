import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { detectGeminiCliVersion } from 'sources/gemini-cli/version.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-cli-version-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

function makeReadJsonSync(map: Record<string, unknown>): (path: string) => unknown {
  return (path: string) => {
    if (!(path in map)) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return map[path];
  };
}

function makeGlob(map: Record<string, string[]>): (pattern: string) => string[] {
  return (pattern: string) => map[pattern] ?? [];
}

test('returns null when no candidate path resolves', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('returns version from npm system-global on macOS when present', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'darwin',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('prefers nvm hits over other locations', () => {
  const nvmPath =
    '/home/u/.nvm/versions/node/v20.5.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'darwin',
    readJsonSync: makeReadJsonSync({
      [nvmPath]: { version: '0.50.0' },
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [nvmPath],
    }),
  });
  expect(result).toBe('0.50.0');
});

test('walks nvm versions in descending order — newest first', () => {
  const oldPath =
    '/home/u/.nvm/versions/node/v18.0.0/lib/node_modules/@google/gemini-cli/package.json';
  const newPath =
    '/home/u/.nvm/versions/node/v22.5.1/lib/node_modules/@google/gemini-cli/package.json';
  const midPath =
    '/home/u/.nvm/versions/node/v20.10.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      [oldPath]: { version: '0.10.0' },
      [midPath]: { version: '0.30.0' },
      [newPath]: { version: '0.41.2' },
    }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [
        oldPath,
        midPath,
        newPath,
      ],
    }),
  });
  expect(result).toBe('0.41.2');
});

test('returns version from bun global when other paths miss', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/home/u/.bun/install/global/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('returns version from pnpm global when other paths miss', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/home/u/.local/share/pnpm/global/5/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('returns version from homebrew arm64 prefix when other paths miss', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'darwin',
    readJsonSync: makeReadJsonSync({
      '/opt/homebrew/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('returns version from .npm-global prefix override', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/home/u/.npm-global/lib/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('checks Windows APPDATA path only on win32', () => {
  const winPath =
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json';
  const result = detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    appdata: 'C:\\Users\\u\\AppData\\Roaming',
    readJsonSync: makeReadJsonSync({ [winPath]: { version: '0.41.2' } }),
    glob: makeGlob({}),
  });
  expect(result).toBe('0.41.2');
});

test('skips Windows path on non-win32 platform', () => {
  const winPath =
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json';
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    appdata: 'C:\\Users\\u\\AppData\\Roaming',
    readJsonSync: makeReadJsonSync({ [winPath]: { version: '0.41.2' } }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('skips win32 platform when appdata is missing', () => {
  const result = detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('skips win32 platform when appdata is empty string', () => {
  const result = detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    appdata: '',
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects non-string version field', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: 123 },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects version with disallowed characters (spaces)', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2 beta' },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects version exceeding 64 characters', () => {
  const huge = 'a'.repeat(65);
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: huge },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects parsed JSON that is not an object', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': 'just-a-string',
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects parsed null', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': null,
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('rejects object missing version field', () => {
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { name: 'x' },
    }),
    glob: makeGlob({}),
  });
  expect(result).toBeNull();
});

test('handles malformed nvm path gracefully (no version triple)', () => {
  const oddPath =
    '/home/u/.nvm/versions/node/system/lib/node_modules/@google/gemini-cli/package.json';
  const result = detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    readJsonSync: makeReadJsonSync({ [oddPath]: { version: '0.41.2' } }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [oddPath],
    }),
  });
  expect(result).toBe('0.41.2');
});

test('default JSON reader path: returns null when ENOENT (real filesystem)', async () => {
  const result = detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
  });
  expect(result).toBeNull();
});

test('default JSON reader: reads a real package.json placed at npm-global location', async () => {
  const pkgDir = join(dir, '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.41.2' }));

  const result = detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
  });
  expect(result).toBe('0.41.2');
});
