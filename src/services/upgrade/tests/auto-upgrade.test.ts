import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAutoUpgrade } from 'services/upgrade/auto-upgrade.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-auto-upgrade-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'fatal' | 'debug';
  obj: Record<string, unknown>;
  msg: string;
}

function makeLogger(
  entries: LogEntry[],
): NonNullable<Parameters<typeof runAutoUpgrade>[0]['logger']> {
  const logger = {
    child: () => logger,
    fatal: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'fatal', obj, msg });
    },
    error: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'error', obj, msg });
    },
    warn: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'warn', obj, msg });
    },
    info: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'info', obj, msg });
    },
    debug: (obj: Record<string, unknown>, msg: string) => {
      entries.push({ level: 'debug', obj, msg });
    },
    trace: () => undefined,
  };
  return logger as unknown as NonNullable<Parameters<typeof runAutoUpgrade>[0]['logger']>;
}

function makeReleaseFetch(
  release: { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> },
  binaryBytes?: Uint8Array,
): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(JSON.stringify(release), {
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
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

test('skips when devMode is true', async () => {
  const entries: LogEntry[] = [];
  let exitCalls = 0;
  await runAutoUpgrade({
    devMode: true,
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
    logger: makeLogger(entries),
    exitProcess: () => {
      exitCalls++;
    },
  });
  expect(entries).toHaveLength(0);
  expect(exitCalls).toBe(0);
});

test('skips when installSource is brew', async () => {
  const entries: LogEntry[] = [];
  let exitCalls = 0;
  await runAutoUpgrade({
    installSource: 'brew',
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: (async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch,
    logger: makeLogger(entries),
    exitProcess: () => {
      exitCalls++;
    },
  });
  expect(entries).toHaveLength(0);
  expect(exitCalls).toBe(0);
});

test('error outcome logs fatal auto_upgrade.check_failed and returns silently', async () => {
  const entries: LogEntry[] = [];
  const fetchFn: typeof globalThis.fetch = (async () =>
    new Response('upstream', { status: 503 })) as unknown as typeof globalThis.fetch;
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  expect(
    entries.some((e) => e.level === 'fatal' && e.obj['event'] === 'auto_upgrade.check_failed'),
  ).toBe(true);
});

test('no_release outcome (404) returns silently with no log entries', async () => {
  const entries: LogEntry[] = [];
  const fetchFn: typeof globalThis.fetch = (async () =>
    new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch;
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  expect(entries).toHaveLength(0);
});

test('no update returns silently', async () => {
  const entries: LogEntry[] = [];
  let exitCalls = 0;
  const fetchFn = makeReleaseFetch({
    tag_name: 'v2026.5.7',
    assets: [
      {
        name: 'proxai-gateway-linux-x64',
        browser_download_url: 'https://example.com/asset',
      },
    ],
  });
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
    exitProcess: () => {
      exitCalls++;
    },
  });
  expect(entries).toHaveLength(0);
  expect(exitCalls).toBe(0);
});

test('update available but no platform asset logs fatal auto_upgrade.no_asset', async () => {
  const entries: LogEntry[] = [];
  const fetchFn = makeReleaseFetch({
    tag_name: 'v2026.5.10',
    assets: [
      {
        name: 'proxai-gateway-darwin-arm64',
        browser_download_url: 'https://example.com/darwin',
      },
    ],
  });
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  const e = entries.find((x) => x.obj['event'] === 'auto_upgrade.no_asset');
  expect(e?.level).toBe('fatal');
  expect(e?.obj['expected']).toBe('proxai-gateway-linux-x64');
});

test('download error logs fatal auto_upgrade.download_failed', async () => {
  const entries: LogEntry[] = [];
  const assetName = 'proxai-gateway-linux-x64';
  const fetchFn: typeof globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: 'v2026.5.10',
          assets: [
            {
              name: assetName,
              browser_download_url: 'https://example.com/asset',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error('connection reset');
  }) as unknown as typeof globalThis.fetch;
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  const e = entries.find((x) => x.obj['event'] === 'auto_upgrade.download_failed');
  expect(e?.level).toBe('fatal');
  expect(String(e?.obj['error'] ?? '')).toContain('connection reset');
});

test('empty download body logs fatal auto_upgrade.download_failed', async () => {
  const entries: LogEntry[] = [];
  const assetName = 'proxai-gateway-linux-x64';
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: 'https://example.com/asset',
        },
      ],
    },
    new Uint8Array(0),
  );
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  const e = entries.find((x) => x.obj['event'] === 'auto_upgrade.download_failed');
  expect(e?.level).toBe('fatal');
  expect(e?.obj['error']).toBe('empty body');
});

test('write failure logs fatal auto_upgrade.write_failed', async () => {
  const entries: LogEntry[] = [];
  const binaryPath = join(dir, 'is-a-dir');
  await mkdir(binaryPath, { recursive: true });
  const assetName = 'proxai-gateway-linux-x64';
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: 'https://example.com/asset',
        },
      ],
    },
    new TextEncoder().encode('binary-bytes'),
  );
  await runAutoUpgrade({
    binaryPath,
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  const e = entries.find((x) => x.obj['event'] === 'auto_upgrade.write_failed');
  expect(e?.level).toBe('fatal');
});

test('successful upgrade logs info auto_upgrade.success and calls exitProcess', async () => {
  const entries: LogEntry[] = [];
  let exitCalls = 0;
  const binaryPath = join(dir, 'gw');
  await writeFile(binaryPath, 'old');
  const newBinary = new TextEncoder().encode('new-binary');
  const assetName = 'proxai-gateway-linux-x64';
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: assetName,
          browser_download_url: 'https://example.com/asset',
        },
      ],
    },
    newBinary,
  );
  await runAutoUpgrade({
    binaryPath,
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
    exitProcess: () => {
      exitCalls++;
    },
  });
  expect(entries.some((e) => e.level === 'info' && e.obj['event'] === 'auto_upgrade.success')).toBe(
    true,
  );
  expect(exitCalls).toBe(1);
  expect(await readFile(binaryPath, 'utf8')).toBe('new-binary');
});

test('successful upgrade with exitProcess undefined does not throw', async () => {
  const entries: LogEntry[] = [];
  const binaryPath = join(dir, 'gw');
  await writeFile(binaryPath, 'old');
  const newBinary = new TextEncoder().encode('new');
  const fetchFn = makeReleaseFetch(
    {
      tag_name: 'v2026.5.10',
      assets: [
        {
          name: 'proxai-gateway-linux-x64',
          browser_download_url: 'https://example.com/asset',
        },
      ],
    },
    newBinary,
  );
  await runAutoUpgrade({
    binaryPath,
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
    platform: 'linux',
    arch: 'x64',
  });
  expect(entries.some((e) => e.level === 'info' && e.obj['event'] === 'auto_upgrade.success')).toBe(
    true,
  );
});

test('platform/arch defaults to process.platform/process.arch when omitted', async () => {
  const entries: LogEntry[] = [];
  const fetchFn: typeof globalThis.fetch = (async () =>
    new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch;
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    logger: makeLogger(entries),
  });
  expect(entries).toHaveLength(0);
});

test('logger and exitProcess undefined branches do not throw on error path', async () => {
  const fetchFn: typeof globalThis.fetch = (async () =>
    new Response('fail', { status: 500 })) as unknown as typeof globalThis.fetch;
  await runAutoUpgrade({
    binaryPath: join(dir, 'gw'),
    currentVersion: '2026.5.7',
    fetch: fetchFn,
    platform: 'linux',
    arch: 'x64',
  });
});

test('fetch dep undefined falls through to globalThis.fetch and emits no_release on 404', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch;
  const entries: LogEntry[] = [];
  try {
    await runAutoUpgrade({
      binaryPath: join(dir, 'gw'),
      currentVersion: '2026.5.7',
      logger: makeLogger(entries),
      platform: 'linux',
      arch: 'x64',
    });
  } finally {
    globalThis.fetch = orig;
  }
  expect(entries).toHaveLength(0);
});
