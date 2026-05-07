import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  await rm(dir, { recursive: true, force: true });
});

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name: string;
  assets: ReleaseAsset[];
}

function makeReleaseFetch(
  response: ReleaseResponse,
  binaryBytes?: Uint8Array,
): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
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
  }) as unknown as typeof globalThis.fetch;
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
  const fetchFn: typeof globalThis.fetch = (async () => {
    throw new Error('boom: connection refused');
  }) as unknown as typeof globalThis.fetch;
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
