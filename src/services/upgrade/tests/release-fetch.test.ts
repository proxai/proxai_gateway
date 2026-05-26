import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { asGlobalFetch, asTimerSetter } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  downloadAsset,
  expectedAssetName,
  fetchLatestRelease,
  findAssetForPlatform,
  RELEASE_API_URL,
  replaceBinary,
} from 'services/upgrade/release-fetch.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-release-fetch-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('expectedAssetName produces unix names without extension', () => {
  expect(expectedAssetName('linux', 'x64')).toBe('proxai-gateway-linux-x64');
  expect(expectedAssetName('darwin', 'arm64')).toBe('proxai-gateway-darwin-arm64');
});

test('expectedAssetName appends .exe on win32', () => {
  expect(expectedAssetName('win32', 'x64')).toBe('proxai-gateway-win32-x64.exe');
});

test('findAssetForPlatform returns the matching asset', () => {
  const release = {
    tag_name: 'v1.0.0',
    assets: [
      { name: 'proxai-gateway-linux-x64', browser_download_url: 'https://example.com/linux' },
      { name: 'proxai-gateway-darwin-arm64', browser_download_url: 'https://example.com/darwin' },
    ],
  };
  const asset = findAssetForPlatform(release, 'darwin', 'arm64');
  expect(asset?.browser_download_url).toBe('https://example.com/darwin');
});

test('findAssetForPlatform returns undefined when nothing matches', () => {
  const release = {
    tag_name: 'v1.0.0',
    assets: [
      { name: 'proxai-gateway-linux-x64', browser_download_url: 'https://example.com/linux' },
    ],
  };
  expect(findAssetForPlatform(release, 'win32', 'x64')).toBeUndefined();
});

test('fetchLatestRelease parses successful body', async () => {
  const fetchFn: FetchFn = async (url: string | URL | Request) => {
    expect(typeof url === 'string' ? url : url.toString()).toBe(RELEASE_API_URL);
    return new Response(
      JSON.stringify({
        tag_name: 'v2026.5.10',
        assets: [{ name: 'asset', browser_download_url: 'https://example.com/asset' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const release = await fetchLatestRelease({ fetch: fetchFn, userAgent: 'ua' });
  expect(release.tag_name).toBe('v2026.5.10');
  expect(release.assets).toHaveLength(1);
});

test('fetchLatestRelease throws on non-2xx', async () => {
  const fetchFn: FetchFn = async () => new Response('boom', { status: 500 });
  await expect(fetchLatestRelease({ fetch: fetchFn, userAgent: 'ua' })).rejects.toThrow(/HTTP 500/);
});

test('fetchLatestRelease throws on malformed body', async () => {
  const fetchFn: FetchFn = async () =>
    new Response(JSON.stringify({ foo: 'bar' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  await expect(fetchLatestRelease({ fetch: fetchFn, userAgent: 'ua' })).rejects.toThrow(
    /malformed/,
  );
});

test('fetchLatestRelease honors custom timeoutMs and aborts', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let captured: (() => void) | null = null;
  globalThis.setTimeout = asTimerSetter((cb: () => void, ms?: number) => {
    if (captured === null) {
      captured = cb;
      return 0;
    }
    return origSetTimeout(cb, ms);
  });
  try {
    const fetchFn: FetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      if (captured !== null) captured();
      if (init?.signal?.aborted === true) {
        const err = new Error('aborted');
        (err as { name: string }).name = 'AbortError';
        throw err;
      }
      return new Response('{}', { status: 200 });
    };
    await expect(
      fetchLatestRelease({ fetch: fetchFn, userAgent: 'ua', timeoutMs: 1 }),
    ).rejects.toThrow();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('fetchLatestRelease falls back to globalThis.fetch when fetch dep is omitted', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = asGlobalFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: 'v1', assets: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    const r = await fetchLatestRelease({ userAgent: 'ua' });
    expect(r.tag_name).toBe('v1');
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('downloadAsset returns bytes on 2xx', async () => {
  const payload = new TextEncoder().encode('hello-world');
  const fetchFn: FetchFn = async () =>
    new Response(payload, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  const bytes = await downloadAsset('https://example.com/asset', {
    fetch: fetchFn,
    userAgent: 'ua',
  });
  expect(new TextDecoder().decode(bytes)).toBe('hello-world');
});

test('downloadAsset throws on non-2xx', async () => {
  const fetchFn: FetchFn = async () => new Response('nope', { status: 404 });
  await expect(
    downloadAsset('https://example.com/asset', { fetch: fetchFn, userAgent: 'ua' }),
  ).rejects.toThrow(/HTTP 404/);
});

test('downloadAsset honors custom timeoutMs and aborts', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let captured: (() => void) | null = null;
  globalThis.setTimeout = asTimerSetter((cb: () => void, ms?: number) => {
    if (captured === null) {
      captured = cb;
      return 0;
    }
    return origSetTimeout(cb, ms);
  });
  try {
    const fetchFn: FetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      if (captured !== null) captured();
      if (init?.signal?.aborted === true) {
        const err = new Error('aborted');
        (err as { name: string }).name = 'AbortError';
        throw err;
      }
      return new Response('x', { status: 200 });
    };
    await expect(
      downloadAsset('https://example.com/asset', {
        fetch: fetchFn,
        userAgent: 'ua',
        timeoutMs: 1,
      }),
    ).rejects.toThrow();
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('downloadAsset falls back to globalThis.fetch when fetch dep is omitted', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = asGlobalFetch(async () => {
    calls++;
    return new Response(new TextEncoder().encode('payload'), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });
  try {
    const bytes = await downloadAsset('https://example.com/asset', { userAgent: 'ua' });
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('replaceBinary writes binary in place on linux/darwin and stagedSibling is null', async () => {
  const binaryPath = join(dir, 'gw');
  await writeFile(binaryPath, 'old');
  const result = await replaceBinary(binaryPath, new TextEncoder().encode('new'), 'linux');
  expect(result.stagedSibling).toBeNull();
  expect(await readFile(binaryPath, 'utf8')).toBe('new');
});

test('replaceBinary writes to .new sibling on win32 and returns its path', async () => {
  const binaryPath = join(dir, 'gw.exe');
  await writeFile(binaryPath, 'running');
  const result = await replaceBinary(binaryPath, new TextEncoder().encode('payload'), 'win32');
  expect(result.stagedSibling).toBe(`${binaryPath}.new`);
  expect(await readFile(`${binaryPath}.new`, 'utf8')).toBe('payload');
  expect(await readFile(binaryPath, 'utf8')).toBe('running');
});

test('replaceBinary surfaces a write error when binaryPath is a directory (linux)', async () => {
  const binaryPath = join(dir, 'is-a-dir');
  await mkdir(binaryPath, { recursive: true });
  await expect(
    replaceBinary(binaryPath, new TextEncoder().encode('x'), 'linux'),
  ).rejects.toBeDefined();
});

test('replaceBinary surfaces a write error when sibling .new path is a directory (win32)', async () => {
  const binaryPath = join(dir, 'gw.exe');
  await writeFile(binaryPath, 'running');
  await mkdir(`${binaryPath}.new`, { recursive: true });
  await expect(
    replaceBinary(binaryPath, new TextEncoder().encode('x'), 'win32'),
  ).rejects.toBeDefined();
});
