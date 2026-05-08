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

test('returns ok with hasUpdate=true when remote tag is newer', async () => {
  const fetchFn = makeFetch({
    tag_name: 'v2026.5.10',
    assets: [{ name: 'asset', browser_download_url: 'https://example.com/asset' }],
  });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind === 'ok') {
    expect(outcome.result.latestVersion).toBe('2026.5.10');
    expect(outcome.result.hasUpdate).toBe(true);
    expect(typeof outcome.result.checkedAt).toBe('string');
  }
});

test('returns ok with hasUpdate=false when remote tag is the same', async () => {
  const fetchFn = makeFetch({ tag_name: 'v2026.5.7', assets: [] });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind === 'ok') {
    expect(outcome.result.hasUpdate).toBe(false);
  }
});

test('returns ok with hasUpdate=false when remote tag is older', async () => {
  const fetchFn = makeFetch({ tag_name: 'v2026.5.5', assets: [] });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind === 'ok') {
    expect(outcome.result.hasUpdate).toBe(false);
  }
});

test('returns no_release on 404 (repo has no published releases yet)', async () => {
  const fetchFn = makeFetch({ status: 404 });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('no_release');
  if (outcome.kind === 'no_release') {
    expect(outcome.reason).toContain('404');
  }
});

test('returns error on network failure', async () => {
  const fetchFn = makeFetch({ error: true });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('error');
  if (outcome.kind === 'error') {
    expect(outcome.reason).toContain('boom');
  }
});

test('returns error on non-404 non-200 response (e.g. 503)', async () => {
  const fetchFn = makeFetch({ status: 503 });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('error');
  if (outcome.kind === 'error') {
    expect(outcome.reason).toContain('503');
  }
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
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('ok');
  if (outcome.kind === 'ok') {
    expect(outcome.result.assetUrl).toBe(url);
  }
});

test('request timeout invokes ctrl.abort() and returns error', async () => {
  const origSetTimeout = globalThis.setTimeout;
  let capturedAbort: (() => void) | null = null;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms?: number) => {
    if (capturedAbort === null) {
      capturedAbort = cb;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return origSetTimeout(cb, ms);
  }) as unknown as typeof setTimeout;

  const fetchFn: typeof globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (capturedAbort !== null) {
      capturedAbort();
    }
    if (init?.signal?.aborted === true) {
      const err = new Error('aborted');
      (err as { name: string }).name = 'AbortError';
      throw err;
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  try {
    const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
    expect(outcome.kind).toBe('error');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('returns error when fetch rejects with a non-Error value', async () => {
  const fetchFn: typeof globalThis.fetch = (async () => {
    throw 'string-thrown';
  }) as unknown as typeof globalThis.fetch;
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('error');
  if (outcome.kind === 'error') {
    expect(outcome.reason).toBe('request failed');
  }
});

test('returns error when remote tag is empty after stripping v prefix', async () => {
  const fetchFn = makeFetch({ tag_name: 'v', assets: [] });
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('error');
  if (outcome.kind === 'error') {
    expect(outcome.reason).toContain('empty');
  }
});

test('returns error on malformed payload (missing tag_name)', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ foo: 'bar' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
  const outcome = await checkLatestVersion({ currentVersion: '2026.5.7', fetch: fetchFn });
  expect(outcome.kind).toBe('error');
  if (outcome.kind === 'error') {
    expect(outcome.reason).toContain('tag_name');
  }
});
