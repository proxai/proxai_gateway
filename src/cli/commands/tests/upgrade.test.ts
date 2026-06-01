import { asTimerSetter } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let statSyncThrowPath: string | null = null;

mock.module('node:fs', () => {
  const actual: typeof import('node:fs') = import.meta.require('node:fs');
  return {
    ...actual,
    existsSync: (path: string): boolean => {
      if (statSyncThrowPath !== null && path === statSyncThrowPath) return true;
      return actual.existsSync(path);
    },
    statSync: (path: string, options?: Parameters<typeof actual.statSync>[1]) => {
      if (statSyncThrowPath !== null && path === statSyncThrowPath) {
        throw new Error('Mock statSync error');
      }
      return actual.statSync(path, options);
    },
  };
});

import { runUpgrade } from 'cli/commands/upgrade.ts';
import { captureOutput } from 'cli/output.ts';

let dir: string;

const realBunSpawn = Bun.spawn;
const realArgv = process.argv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-upgrade-'));
});

afterEach(async () => {
  Bun.spawn = realBunSpawn;
  process.argv = realArgv;
  await rmRecursive(dir);
  statSyncThrowPath = null;
});

afterAll(async () => {
  const fsReal = await import('node:fs');
  mock.module('node:fs', () => fsReal);
});

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name: string;
  assets: ReleaseAsset[];
}

function makeReleaseFetch(response: ReleaseResponse, binaryBytes?: Uint8Array): FetchFn {
  return async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (binaryBytes !== undefined) {
      return new Response(binaryBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

test('reports already at latest when current >= remote', async () => {
  const out = captureOutput();
  const fetchFn = makeReleaseFetch({ tag_name: 'v2026.5.7', assets: [] });
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('already at latest'))).toBe(true);
});

test('newer version available downloads, writes binary, and reports success', async () => {
  const binaryPath = join(dir, 'proxai-gateway');
  await writeFile(binaryPath, 'old-binary');
  const out = captureOutput();
  const newBinary = new TextEncoder().encode('new-binary-content');
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
        },
      ],
    },
    newBinary,
  );
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath,
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.level === 'success' && l.msg.includes('upgraded to'))).toBe(true);
  const text = await readFile(binaryPath, 'utf8');
  expect(text).toBe('new-binary-content');
});

test('same-day hyphen re-release is treated as newer and upgrades', async () => {
  const binaryPath = join(dir, 'proxai-gateway');
  await writeFile(binaryPath, 'old-binary');
  const out = captureOutput();
  const newBinary = new TextEncoder().encode('new-binary-content');
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.6.1-1',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.6.1-1/${assetName}`,
        },
      ],
    },
    newBinary,
  );
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.6.1',
    binaryPath,
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('already at latest'))).toBe(false);
  expect(
    out.lines.some((l) => l.level === 'success' && l.msg.includes('upgraded to 2026.6.1-1')),
  ).toBe(true);
  expect(await readFile(binaryPath, 'utf8')).toBe('new-binary-content');
});

test('network failure during version check returns error', async () => {
  const out = captureOutput();
  const fetchFn: FetchFn = async () => {
    throw new Error('boom: connection refused');
  };
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to check'))).toBe(
    true,
  );
});

test('asset not found for current platform returns error', async () => {
  const out = captureOutput();
  const fetchFn = makeReleaseFetch({
    tag_name: 'v2026.5.10',
    assets: [
      {
        name: 'proxai-gateway-darwin-arm64',
        browser_download_url: 'https://example.com/asset',
      },
    ],
  });
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath: join(dir, 'proxai-gateway'),
      fetch: fetchFn,
      platform: 'linux',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('no asset found'))).toBe(true);
});

test('release tag with no parseable version returns error', async () => {
  const out = captureOutput();
  const fetchFn = makeReleaseFetch({ tag_name: 'v', assets: [] });
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && l.msg.includes('could not parse version')),
  ).toBe(true);
});

test('release HTTP non-200 surfaces an error', async () => {
  const out = captureOutput();
  const fetchFn: FetchFn = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response('forbidden', { status: 403 });
    }
    return new Response('', { status: 404 });
  };
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to check'))).toBe(
    true,
  );
});

test('malformed release payload surfaces an error', async () => {
  const out = captureOutput();
  const fetchFn: FetchFn = async () =>
    new Response(JSON.stringify({ foo: 'bar' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(1);
});

test('download HTTP non-200 surfaces an error', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn: FetchFn = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v2026.5.10',
          assets: [
            {
              name: assetName,
              browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  };
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath: join(dir, 'proxai-gateway'),
      fetch: fetchFn,
      platform: 'linux',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('download failed'))).toBe(
    true,
  );
});

test('download throwing surfaces an error', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn: FetchFn = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v2026.5.10',
          assets: [
            {
              name: assetName,
              browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error('connection reset');
  };
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath: join(dir, 'proxai-gateway'),
      fetch: fetchFn,
      platform: 'linux',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('download failed'))).toBe(
    true,
  );
});

test('empty downloaded body surfaces a verification error', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
        },
      ],
    },
    new Uint8Array(0),
  );
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath: join(dir, 'proxai-gateway'),
      fetch: fetchFn,
      platform: 'linux',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && l.msg.includes('download verification failed')),
  ).toBe(true);
});

test('write to binaryPath failure surfaces an install error', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const binaryPath = join(dir, 'is-a-dir');
  await mkdir(binaryPath, { recursive: true });
  const newBinary = new TextEncoder().encode('new-binary');
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
        },
      ],
    },
    newBinary,
  );
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath,
      fetch: fetchFn,
      platform: 'linux',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to install upgrade')),
  ).toBe(true);
});

test('windows write failure to .new path surfaces an error', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-win32-${process.arch}.exe`;
  const newBinary = new TextEncoder().encode('payload');
  const binaryPath = join(dir, 'win-binary');
  await mkdir(`${binaryPath}.new`, { recursive: true });
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
        },
      ],
    },
    newBinary,
  );
  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath,
      fetch: fetchFn,
      platform: 'win32',
    },
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to write'))).toBe(
    true,
  );
});

test('release fetch timeout aborts the request via setTimeout callback', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let capturedAbort: (() => void) | null = null;
  globalThis.setTimeout = asTimerSetter((cb: () => void, _ms?: number) => {
    if (capturedAbort === null) {
      capturedAbort = cb;
      return 0;
    }
    return origSetTimeout(cb, _ms);
  });

  const out = captureOutput();
  const fetchFn: FetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
    if (capturedAbort !== null) {
      capturedAbort();
    }
    if (init?.signal?.aborted === true) {
      const err = new Error('aborted');
      (err as { name: string }).name = 'AbortError';
      throw err;
    }
    return new Response('{}', { status: 200 });
  };

  try {
    const result = await runUpgrade({
      output: out,
      currentVersion: '2026.5.7',
      binaryPath: join(dir, 'binary'),
      fetch: fetchFn,
      platform: 'linux',
    });
    expect(result.exitCode).toBe(1);
    expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to check'))).toBe(
      true,
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('download fetch timeout aborts the request via setTimeout callback', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let capturedAbort: (() => void) | null = null;
  let releaseTimerInstalled = false;

  globalThis.setTimeout = asTimerSetter((cb: () => void, ms?: number) => {
    if (!releaseTimerInstalled) {
      releaseTimerInstalled = true;
      return origSetTimeout(cb, ms);
    }
    if (capturedAbort === null) {
      capturedAbort = cb;
      return 0;
    }
    return origSetTimeout(cb, ms);
  });

  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn: FetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v2026.5.10',
          assets: [
            {
              name: assetName,
              browser_download_url: `https://example.com/download/${assetName}`,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (capturedAbort !== null) {
      capturedAbort();
    }
    if (init?.signal?.aborted === true) {
      const err = new Error('aborted');
      (err as { name: string }).name = 'AbortError';
      throw err;
    }
    return new Response('not reached', { status: 200 });
  };

  try {
    const result = await runUpgrade(
      {
        output: out,
        currentVersion: '2026.5.7',
        binaryPath: join(dir, 'binary'),
        fetch: fetchFn,
        platform: 'linux',
      },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('download failed'))).toBe(
      true,
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('windows writes a sibling .new file and does not overwrite existing binary', async () => {
  const binaryPath = join(dir, 'proxai-gateway.exe');
  await writeFile(binaryPath, 'running-exe');
  const out = captureOutput();
  const newBinary = new TextEncoder().encode('new-exe-bytes');
  const assetName = `proxai-gateway-win32-${process.arch}.exe`;
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
        },
      ],
    },
    newBinary,
  );

  const result = await runUpgrade(
    {
      output: out,
      currentVersion: '2026.5.7',
      binaryPath,
      fetch: fetchFn,
      platform: 'win32',
    },
    {},
  );
  expect(result.exitCode).toBe(0);
  const newText = await readFile(`${binaryPath}.new`, 'utf8');
  expect(newText).toBe('new-exe-bytes');
  const oldText = await readFile(binaryPath, 'utf8');
  expect(oldText).toBe('running-exe');
});

test('local build path upgrade triggers local rebuild flow', async () => {
  const origSpawn = Bun.spawn;
  let spawnedCmd: string[] = [];
  Bun.spawn = ((options: { cmd: string[] }) => {
    spawnedCmd = options.cmd;
    return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  const out = captureOutput();
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: '/workspace/dist/darwin-arm64/proxai-gateway',
    platform: 'darwin',
  });
  expect(result.exitCode).toBe(0);
  expect(spawnedCmd).toEqual(['bun', 'scripts/build.ts', 'darwin-arm64']);
  expect(
    out.lines.some((l) => l.level === 'info' && l.msg.includes('Local development build detected')),
  ).toBe(true);
  expect(
    out.lines.some(
      (l) => l.level === 'success' && l.msg.includes('Local build upgraded successfully'),
    ),
  ).toBe(true);
  Bun.spawn = origSpawn;
});

test('local build path upgrade resolves repository root correctly', async () => {
  const origSpawn = Bun.spawn;
  let spawnedCmd: string[] = [];
  let spawnedCwd: string | undefined;
  Bun.spawn = ((options: { cmd: string[]; cwd?: string }) => {
    spawnedCmd = options.cmd;
    spawnedCwd = options.cwd;

    return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;

  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@proxai/gateway' }));
  await writeFile(join(dir, 'scripts/build.ts'), 'console.log("build mock")');

  const origArgv = process.argv;
  process.argv = ['/usr/local/bin/bun', '/outside/of/any/repo/script.ts'];

  const binaryPath = join(dir, 'dist/darwin-arm64/proxai-gateway');
  const out1 = captureOutput();
  const result1 = await runUpgrade({
    output: out1,
    currentVersion: '2026.5.7',
    binaryPath,
    platform: 'darwin',
  });
  expect(result1.exitCode).toBe(0);
  expect(spawnedCmd).toEqual(['bun', 'scripts/build.ts', 'darwin-arm64']);
  expect(spawnedCwd).toBe(dir);

  process.argv = ['/usr/local/bin/bun', join(dir, 'src/main.ts')];

  const out2 = captureOutput();
  const result2 = await runUpgrade({
    output: out2,
    currentVersion: '2026.5.7',
    binaryPath: '/usr/local/bin/bun',
    platform: 'darwin',
  });
  expect(result2.exitCode).toBe(0);
  expect(spawnedCmd).toEqual(['bun', 'scripts/build.ts', `darwin-${process.arch}`]);
  expect(spawnedCwd).toBe(dir);

  Bun.spawn = origSpawn;
  process.argv = origArgv;
});

test('local build path upgrade reports failure on non-zero exit code', async () => {
  const origSpawn = Bun.spawn;
  Bun.spawn = (() => {
    return { exited: Promise.resolve(42) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  const out = captureOutput();
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: '/workspace/dist/darwin-arm64/proxai-gateway',
    platform: 'darwin',
  });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some(
      (l) => l.level === 'error' && l.msg.includes('Local rebuild failed with exit code 42'),
    ),
  ).toBe(true);
  Bun.spawn = origSpawn;
});

test('local build path upgrade handles repository root not found', async () => {
  const origSpawn = Bun.spawn;
  Bun.spawn = (() => {
    return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  const out = captureOutput();
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: '/non/existent/src/main.ts',
    platform: 'darwin',
  });
  expect(result.exitCode).toBe(0);
  Bun.spawn = origSpawn;
});

test('local build repo-root finder falls into dirname branch when statSync throws', async () => {
  const origSpawn = Bun.spawn;
  Bun.spawn = (() => {
    return { exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  const origArgv = process.argv;
  process.argv = ['/usr/local/bin/bun', '/outside/of/any/repo/script.ts'];

  const binaryPath = join(dir, 'src', 'main.ts');
  statSyncThrowPath = resolve(binaryPath);

  const out = captureOutput();
  try {
    const result = await runUpgrade({
      output: out,
      currentVersion: '2026.5.7',
      binaryPath,
      platform: 'darwin',
    });
    expect(result.exitCode).toBe(0);
    expect(
      out.lines.some(
        (l) => l.level === 'info' && l.msg.includes('Local development build detected'),
      ),
    ).toBe(true);
  } finally {
    Bun.spawn = origSpawn;
    process.argv = origArgv;
  }
});
