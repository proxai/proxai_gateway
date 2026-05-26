import { asTimerSetter } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, runUpgrade } from 'cli/commands/upgrade.ts';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-upgrade-'));
});

afterEach(async () => {
  await rmRecursive(dir);
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

test('compareVersions handles CalVer-style strings', () => {
  expect(compareVersions('2026.5.10', '2026.5.7')).toBe(1);
  expect(compareVersions('2026.5.7', '2026.5.10')).toBe(-1);
  expect(compareVersions('2026.5.7', '2026.5.7')).toBe(0);
  expect(compareVersions('2026.6.1', '2026.5.31')).toBe(1);
});

test('reports already at latest when current >= remote', async () => {
  const out = captureOutput();
  const fetchFn = makeReleaseFetch({ tag_name: 'v2026.5.7', assets: [] });
  const result = await runUpgrade({
    output: out,
    currentVersion: '2026.5.7',
    binaryPath: join(dir, 'proxai-gateway'),
    fetch: fetchFn,
    platform: 'linux',
    isTty: () => false,
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('already at latest'))).toBe(true);
});

test('confirm declined returns ok and does not write binary', async () => {
  const binaryPath = join(dir, 'proxai-gateway');
  await writeFile(binaryPath, 'old-binary');
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn = makeReleaseFetch({
    tag_name: 'v2026.5.10',
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
      },
    ],
  });
  const prompts = scriptedPrompts({ upgrade: false });
  const result = await runUpgrade({
    output: out,
    prompts,
    currentVersion: '2026.5.7',
    binaryPath,
    fetch: fetchFn,
    platform: 'linux',
    isTty: () => true,
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('upgrade cancelled'))).toBe(true);
  const text = await readFile(binaryPath, 'utf8');
  expect(text).toBe('old-binary');
});

test('confirm accepted downloads, writes binary, and reports success', async () => {
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
  const prompts = scriptedPrompts({ upgrade: true });
  const result = await runUpgrade(
    {
      output: out,
      prompts,
      currentVersion: '2026.5.7',
      binaryPath,
      fetch: fetchFn,
      platform: 'linux',
      isTty: () => true,
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.level === 'success' && l.msg.includes('upgraded to'))).toBe(true);
  const text = await readFile(binaryPath, 'utf8');
  expect(text).toBe('new-binary-content');
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
    isTty: () => false,
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
      isTty: () => false,
    },
    { yes: true },
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
    isTty: () => false,
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
    isTty: () => false,
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
    isTty: () => false,
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
      isTty: () => false,
    },
    { yes: true },
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
      isTty: () => false,
    },
    { yes: true },
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
      isTty: () => false,
    },
    { yes: true },
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
      isTty: () => false,
    },
    { yes: true },
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
      isTty: () => false,
    },
    { yes: true },
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
      isTty: () => false,
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
        isTty: () => false,
      },
      { yes: true },
    );
    expect(result.exitCode).toBe(1);
    expect(out.lines.some((l) => l.level === 'error' && l.msg.includes('download failed'))).toBe(
      true,
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('confirm accepted via prompts (no yes flag, isTty true) proceeds with upgrade', async () => {
  const binaryPath = join(dir, 'binary-via-prompt');
  await writeFile(binaryPath, 'old');
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
  const prompts = scriptedPrompts({ upgrade: true });
  const result = await runUpgrade({
    output: out,
    prompts,
    currentVersion: '2026.5.7',
    binaryPath,
    fetch: fetchFn,
    platform: 'linux',
    isTty: () => true,
  });
  expect(result.exitCode).toBe(0);
  const text = await readFile(binaryPath, 'utf8');
  expect(text).toBe('new-binary-content');
});

test('confirm declined via prompts (no yes flag, isTty true) returns ok', async () => {
  const binaryPath = join(dir, 'proxai-gateway');
  await writeFile(binaryPath, 'old-binary');
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const fetchFn = makeReleaseFetch({
    tag_name: 'v2026.5.10',
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/proxai/proxai_gateway/releases/download/v2026.5.10/${assetName}`,
      },
    ],
  });
  const prompts = scriptedPrompts({ upgrade: false });
  const result = await runUpgrade({
    output: out,
    prompts,
    currentVersion: '2026.5.7',
    binaryPath,
    fetch: fetchFn,
    platform: 'linux',
    isTty: () => true,
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('upgrade cancelled'))).toBe(true);
});

test('runUpgrade default isTty path is reachable when omitted (no prompts)', async () => {
  const out = captureOutput();
  const assetName = `proxai-gateway-linux-${process.arch}`;
  const newBinary = new TextEncoder().encode('payload');
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
    binaryPath: join(dir, 'proxai-gateway-default-tty'),
    fetch: fetchFn,
    platform: 'linux',
  });
  expect(result.exitCode).toBe(0);
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
      isTty: () => false,
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  const newText = await readFile(`${binaryPath}.new`, 'utf8');
  expect(newText).toBe('new-exe-bytes');
  const oldText = await readFile(binaryPath, 'utf8');
  expect(oldText).toBe('running-exe');
});
