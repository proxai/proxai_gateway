import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { __resetLayer3Cache, detectGeminiCliVersion } from 'sources/gemini-cli/version.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-cli-version-'));
  __resetLayer3Cache();
});

afterEach(async () => {
  await rmRecursive(dir);
});

const noWhich = (): string | null => null;
const noSpawn = async (): Promise<{ stdout: string; exitCode: number }> => ({
  stdout: '',
  exitCode: 1,
});
const noFetch = async (): Promise<Response> => new Response('not found', { status: 404 });

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

test('Layer 1: returns version when which + spawn succeed with valid stdout', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2\n', exitCode: 0 }),
  });
  expect(result).toBe('0.41.2');
});

test('Layer 1: trims and uses only first line of stdout', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '  0.41.2  \nextra info\n', exitCode: 0 }),
  });
  expect(result).toBe('0.41.2');
});

test('Layer 1: which returns null falls through to L2', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.40.0' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.40.0');
});

test('Layer 1: spawn non-zero exit falls through to L2', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2', exitCode: 2 }),
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.40.0' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.40.0');
});

test('Layer 1: spawn throws falls through to L2', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => {
      throw new Error('spawn EACCES');
    },
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.40.0' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.40.0');
});

test('Layer 1: empty stdout falls through', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '   \n', exitCode: 0 }),
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 1: invalid version chars in stdout fall through', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2 with extra space\n', exitCode: 0 }),
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: darwin includes homebrew arm64 and excludes Windows paths', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'darwin',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/opt/homebrew/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: linux includes /usr and snap; excludes homebrew', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/snap/node/current/lib/node_modules/@google/gemini-cli/package.json': { version: '0.30.0' },
      '/opt/homebrew/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.30.0');
});

test('Layer 2: linux skips homebrew path even if file is present', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/opt/homebrew/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: walks nvm versions in descending order — newest first', async () => {
  const oldPath =
    '/home/u/.nvm/versions/node/v18.0.0/lib/node_modules/@google/gemini-cli/package.json';
  const newPath =
    '/home/u/.nvm/versions/node/v22.5.1/lib/node_modules/@google/gemini-cli/package.json';
  const midPath =
    '/home/u/.nvm/versions/node/v20.10.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
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
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: handles malformed nvm path gracefully (no version triple)', async () => {
  const oddPath =
    '/home/u/.nvm/versions/node/system/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [oddPath]: { version: '0.41.2' } }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [oddPath],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: bun global', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/home/u/.bun/install/global/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: pnpm global', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/home/u/.local/share/pnpm/global/5/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: asdf nodejs', async () => {
  const path =
    '/home/u/.asdf/installs/nodejs/22.5.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [path]: { version: '0.41.2' } }),
    glob: makeGlob({
      '/home/u/.asdf/installs/nodejs/*/lib/node_modules/@google/gemini-cli/package.json': [path],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: rtx node', async () => {
  const path =
    '/home/u/.local/share/rtx/installs/node/22.5.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [path]: { version: '0.41.2' } }),
    glob: makeGlob({
      '/home/u/.local/share/rtx/installs/node/*/lib/node_modules/@google/gemini-cli/package.json': [
        path,
      ],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: mise node', async () => {
  const path =
    '/home/u/.local/share/mise/installs/node/22.5.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [path]: { version: '0.41.2' } }),
    glob: makeGlob({
      '/home/u/.local/share/mise/installs/node/*/lib/node_modules/@google/gemini-cli/package.json':
        [path],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: .npm-global prefix override', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/home/u/.npm-global/lib/node_modules/@google/gemini-cli/package.json': {
        version: '0.41.2',
      },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: rejects non-string version field', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: 123 },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: rejects version with disallowed characters (spaces)', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.41.2 beta' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: rejects version exceeding 64 characters', async () => {
  const huge = 'a'.repeat(65);
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: huge },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: rejects parsed JSON that is not an object', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': 'just-a-string',
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: rejects parsed null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': null,
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: rejects object missing version field', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { name: 'x' },
    }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: win32 includes APPDATA npm path', async () => {
  const winPath =
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [winPath]: { version: '0.41.2' } }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: win32 nvm-windows version glob descending', async () => {
  const oldPath =
    'C:\\Users\\u\\AppData\\Roaming\\nvm\\v18.0.0\\node_modules\\@google\\gemini-cli\\package.json';
  const newPath =
    'C:\\Users\\u\\AppData\\Roaming\\nvm\\v22.5.0\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      [oldPath]: { version: '0.10.0' },
      [newPath]: { version: '0.41.2' },
    }),
    glob: makeGlob({
      'C:\\Users\\u\\AppData\\Roaming\\nvm\\v*\\node_modules\\@google\\gemini-cli\\package.json': [
        oldPath,
        newPath,
      ],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: win32 scoop nodejs path', async () => {
  const path =
    'C:\\Users\\u\\scoop\\persist\\nodejs\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\u' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [path]: { version: '0.41.2' } }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: win32 user bun global path', async () => {
  const path =
    'C:\\Users\\u\\.bun\\install\\global\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\u' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [path]: { version: '0.41.2' } }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: win32 fnm LOCALAPPDATA path with descending sort', async () => {
  const oldPath =
    'C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v18.0.0\\installation\\node_modules\\@google\\gemini-cli\\package.json';
  const newPath =
    'C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v22.5.0\\installation\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      [oldPath]: { version: '0.10.0' },
      [newPath]: { version: '0.41.2' },
    }),
    glob: makeGlob({
      'C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v*\\installation\\node_modules\\@google\\gemini-cli\\package.json':
        [oldPath, newPath],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: win32 with no env vars set yields no candidates', async () => {
  const result = await detectGeminiCliVersion({
    homedir: 'C:\\Users\\u',
    platform: 'win32',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 2: skips Windows paths on non-win32 platform', async () => {
  const winPath =
    'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({ [winPath]: { version: '0.41.2' } }),
    glob: makeGlob({}),
    fetch: noFetch,
  });
  expect(result).toBeNull();
});

test('Layer 3: returns version from valid GitHub release', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () =>
      new Response(JSON.stringify({ tag_name: 'v0.41.2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  expect(result).toBe('0.41.2');
});

test('Layer 3: tag without v prefix accepted', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response(JSON.stringify({ tag_name: '0.41.2' }), { status: 200 }),
  });
  expect(result).toBe('0.41.2');
});

test('Layer 3: tag_name missing → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response(JSON.stringify({ name: 'release' }), { status: 200 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: invalid tag chars → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () =>
      new Response(JSON.stringify({ tag_name: 'v0.41.2 with space' }), { status: 200 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: non-200 response → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: 500 response → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response('server error', { status: 500 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: fetch throws (network/timeout) → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => {
      throw new Error('network unreachable');
    },
  });
  expect(result).toBeNull();
});

test('Layer 3: response.json() throws → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response('not json', { status: 200 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: non-object body → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response(JSON.stringify('plain string'), { status: 200 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: tag_name as non-string → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response(JSON.stringify({ tag_name: 42 }), { status: 200 }),
  });
  expect(result).toBeNull();
});

test('Layer 3: cache memoizes successive calls', async () => {
  let fetchCalls = 0;
  const fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ tag_name: 'v0.41.2' }), { status: 200 });
  };
  const baseDeps = {
    homedir: '/home/u',
    platform: 'linux' as const,
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: fetchImpl,
  };
  const first = await detectGeminiCliVersion(baseDeps);
  const second = await detectGeminiCliVersion(baseDeps);
  expect(first).toBe('0.41.2');
  expect(second).toBe('0.41.2');
  expect(fetchCalls).toBe(1);
});

test('Layer 3: __resetLayer3Cache forces refetch', async () => {
  let fetchCalls = 0;
  const fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ tag_name: 'v0.41.2' }), { status: 200 });
  };
  const baseDeps = {
    homedir: '/home/u',
    platform: 'linux' as const,
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: fetchImpl,
  };
  await detectGeminiCliVersion(baseDeps);
  __resetLayer3Cache();
  await detectGeminiCliVersion(baseDeps);
  expect(fetchCalls).toBe(2);
});

test('Layer 3: caches null outcomes too (no thrash on persistent failure)', async () => {
  let fetchCalls = 0;
  const fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = async () => {
    fetchCalls++;
    return new Response('boom', { status: 500 });
  };
  const baseDeps = {
    homedir: '/home/u',
    platform: 'linux' as const,
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: fetchImpl,
  };
  const first = await detectGeminiCliVersion(baseDeps);
  const second = await detectGeminiCliVersion(baseDeps);
  expect(first).toBeNull();
  expect(second).toBeNull();
  expect(fetchCalls).toBe(1);
});

test('Integration: all layers fail → null', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBeNull();
});

test('Integration: L1 succeeds → L2 and L3 not called', async () => {
  let l2Calls = 0;
  let l3Calls = 0;
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: () => '/usr/bin/gemini',
    spawn: async () => ({ stdout: '0.41.2\n', exitCode: 0 }),
    readJsonSync: () => {
      l2Calls++;
      throw new Error('should not be called');
    },
    glob: () => {
      l2Calls++;
      return [];
    },
    fetch: async () => {
      l3Calls++;
      return new Response('', { status: 200 });
    },
  });
  expect(result).toBe('0.41.2');
  expect(l2Calls).toBe(0);
  expect(l3Calls).toBe(0);
});

test('Integration: L1 fails, L2 succeeds → L3 not called', async () => {
  let l3Calls = 0;
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      '/usr/local/lib/node_modules/@google/gemini-cli/package.json': { version: '0.40.0' },
    }),
    glob: makeGlob({}),
    fetch: async () => {
      l3Calls++;
      return new Response('', { status: 200 });
    },
  });
  expect(result).toBe('0.40.0');
  expect(l3Calls).toBe(0);
});

test('Integration: L1+L2 fail, L3 succeeds', async () => {
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response(JSON.stringify({ tag_name: 'v0.41.2' }), { status: 200 }),
  });
  expect(result).toBe('0.41.2');
});

test('default real-fs path: returns null when nothing installed under temp homedir', async () => {
  const result = await detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBeNull();
});

test('default real-fs path: reads a real package.json placed at npm-global location', async () => {
  const pkgDir = join(dir, '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.41.2' }));
  const result = await detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBe('0.41.2');
});

test('default real-fs path: glob default returns empty for missing nvm tree', async () => {
  const result = await detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({}),
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBeNull();
});

test('default real-fs path: glob finds real nvm tree under temp homedir', async () => {
  const nvmDir = join(
    dir,
    '.nvm',
    'versions',
    'node',
    'v22.5.0',
    'lib',
    'node_modules',
    '@google',
    'gemini-cli',
  );
  await mkdir(nvmDir, { recursive: true });
  await writeFile(join(nvmDir, 'package.json'), JSON.stringify({ version: '0.41.2' }));
  const result = await detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toBe('0.41.2');
});

test('default spawn path: invokes real binary via process.execPath --version', async () => {
  const result = await detectGeminiCliVersion({
    homedir: dir,
    platform: 'linux',
    which: () => process.execPath,
    readJsonSync: makeReadJsonSync({}),
    glob: makeGlob({}),
    fetch: async () => new Response('not found', { status: 404 }),
  });
  expect(result).toMatch(/^[\w.+:/-]{1,64}$/);
});

test('Layer 2: nvm sort orders by minor when major matches', async () => {
  const v22_3 =
    '/home/u/.nvm/versions/node/v22.3.0/lib/node_modules/@google/gemini-cli/package.json';
  const v22_10 =
    '/home/u/.nvm/versions/node/v22.10.0/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      [v22_3]: { version: '0.30.0' },
      [v22_10]: { version: '0.41.2' },
    }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [
        v22_3,
        v22_10,
      ],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});

test('Layer 2: nvm sort orders by patch when major+minor match', async () => {
  const v22_5_0 =
    '/home/u/.nvm/versions/node/v22.5.0/lib/node_modules/@google/gemini-cli/package.json';
  const v22_5_3 =
    '/home/u/.nvm/versions/node/v22.5.3/lib/node_modules/@google/gemini-cli/package.json';
  const result = await detectGeminiCliVersion({
    homedir: '/home/u',
    platform: 'linux',
    which: noWhich,
    spawn: noSpawn,
    readJsonSync: makeReadJsonSync({
      [v22_5_0]: { version: '0.30.0' },
      [v22_5_3]: { version: '0.41.2' },
    }),
    glob: makeGlob({
      '/home/u/.nvm/versions/node/*/lib/node_modules/@google/gemini-cli/package.json': [
        v22_5_0,
        v22_5_3,
      ],
    }),
    fetch: noFetch,
  });
  expect(result).toBe('0.41.2');
});
