import { expect, test } from 'bun:test';

import { checkLatestVersion } from 'services/polling/version-check.ts';

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name: string;
  assets: ReleaseAsset[];
}

function makeFetch(
  response: ReleaseResponse | { error: true } | { status: number },
): typeof globalThis.fetch {
  return (async () => {
    if ('error' in response && response.error) {
      throw new Error('boom');
    }
    if ('status' in response) {
      return new Response('not found', { status: response.status });
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

test('returns hasUpdate=true when remote tag is newer', async () => {
  const fetchFn = makeFetch({
    tag_name: 'v2026.5.10',
    assets: [{ name: 'asset', browser_download_url: 'https://example.com/asset' }],
  });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).not.toBeNull();
  expect(result?.latestVersion).toBe('2026.5.10');
  expect(result?.hasUpdate).toBe(true);
  expect(typeof result?.checkedAt).toBe('string');
});

test('returns hasUpdate=false when remote tag is the same', async () => {
  const fetchFn = makeFetch({
    tag_name: 'v2026.5.7',
    assets: [],
  });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).not.toBeNull();
  expect(result?.hasUpdate).toBe(false);
});

test('returns hasUpdate=false when remote tag is older', async () => {
  const fetchFn = makeFetch({
    tag_name: 'v2026.5.5',
    assets: [],
  });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).not.toBeNull();
  expect(result?.hasUpdate).toBe(false);
});

test('returns null on network failure', async () => {
  const fetchFn = makeFetch({ error: true });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).toBeNull();
});

test('returns null on non-200 response', async () => {
  const fetchFn = makeFetch({ status: 503 });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).toBeNull();
});

test('populates assetUrl when matching asset exists for current platform', async () => {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === 'win32' ? '.exe' : '';
  const expectedAssetName = `proxai-gateway-${platform}-${arch}${ext}`;
  const url = `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${expectedAssetName}`;
  const fetchFn = makeFetch({
    tag_name: 'v2026.5.10',
    assets: [{ name: expectedAssetName, browser_download_url: url }],
  });
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result?.assetUrl).toBe(url);
});

test('returns null on malformed payload', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ foo: 'bar' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
  const result = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(result).toBeNull();
});
