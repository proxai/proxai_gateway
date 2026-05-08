import { setMode } from 'core/io/fs';
import { basename } from 'node:path';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';

export interface UpgradeCommandDeps {
  output: OutputSink;
  currentVersion: string;
  binaryPath: string;
  prompts?: PromptSink;
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  isTty?: () => boolean;
}

export interface UpgradeCommandOptions {
  yes?: boolean;
  force?: boolean;
}

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface ReleaseInfo {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
}

const RELEASE_API_URL = 'https://api.github.com/repos/proxai/proxai_gateway/releases/latest';
const NETWORK_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function runUpgrade(
  deps: UpgradeCommandDeps,
  options: UpgradeCommandOptions = {},
): Promise<CommandResult> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const platform = deps.platform ?? process.platform;

  let release: ReleaseInfo;
  try {
    release = await fetchLatestRelease(fetchFn);
  } catch (err) {
    deps.output.error(`failed to check for updates: ${(err as Error).message ?? String(err)}`);
    return { exitCode: EXIT_CODE.error };
  }

  const latestVersion = stripV(release.tag_name);
  if (latestVersion.length === 0) {
    deps.output.error(`could not parse version from release tag: ${release.tag_name}`);
    return { exitCode: EXIT_CODE.error };
  }

  const cmp = compareVersions(latestVersion, deps.currentVersion);
  if (cmp <= 0 && options.force !== true) {
    deps.output.info(`already at latest version: ${deps.currentVersion}`);
    return { exitCode: EXIT_CODE.ok };
  }

  deps.output.info(`upgrade available: ${deps.currentVersion} -> ${latestVersion}`);

  if (options.yes !== true && (deps.isTty ?? defaultIsTty)()) {
    const prompts = deps.prompts;
    if (prompts !== undefined) {
      const ok = await prompts.confirmUpgrade(`upgrade to ${latestVersion}?`);
      if (!ok) {
        deps.output.info('upgrade cancelled — current version retained');
        return { exitCode: EXIT_CODE.ok };
      }
    }
  }

  const arch = process.arch;
  const ext = platform === 'win32' ? '.exe' : '';
  const expectedAssetName = `proxai-gateway-${platform}-${arch}${ext}`;
  const asset = release.assets.find((a) => a.name === expectedAssetName);
  if (asset === undefined) {
    deps.output.error(`no asset found for this platform: ${expectedAssetName}`);
    return { exitCode: EXIT_CODE.error };
  }

  let downloadedBytes: Uint8Array;
  try {
    downloadedBytes = await downloadAsset(fetchFn, asset.browser_download_url);
  } catch (err) {
    deps.output.error(`download failed: ${(err as Error).message ?? String(err)}`);
    return { exitCode: EXIT_CODE.error };
  }

  if (downloadedBytes.byteLength <= 0) {
    deps.output.error('download verification failed: empty file');
    return { exitCode: EXIT_CODE.error };
  }

  if (platform === 'win32') {
    const sibling = `${deps.binaryPath}.new`;
    try {
      await Bun.write(sibling, downloadedBytes);
    } catch (err) {
      deps.output.error(`failed to write ${sibling}: ${(err as Error).message ?? String(err)}`);
      return { exitCode: EXIT_CODE.error };
    }
    deps.output.success(
      `downloaded to ${sibling}; restart the service to apply (replace ${basename(deps.binaryPath)} with ${basename(sibling)} after stopping the daemon)`,
    );
    return { exitCode: EXIT_CODE.ok };
  }

  try {
    await Bun.write(deps.binaryPath, downloadedBytes);
    await setMode(deps.binaryPath, 0o755);
  } catch (err) {
    deps.output.error(
      `failed to install upgrade at ${deps.binaryPath}: ${(err as Error).message ?? String(err)}`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  deps.output.success(`upgraded to ${latestVersion}; restart the daemon to apply`);
  return { exitCode: EXIT_CODE.ok };
}

async function fetchLatestRelease(fetchFn: typeof globalThis.fetch): Promise<ReleaseInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetchFn(RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'proxai-gateway-upgrade',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status.toString()} from ${RELEASE_API_URL}`);
    }
    const body = (await res.json()) as ReleaseInfo;
    if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) {
      throw new Error('malformed release payload');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAsset(fetchFn: typeof globalThis.fetch, url: string): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'proxai-gateway-upgrade',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status.toString()} from ${url}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }
}

function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

function parseVersion(v: string): number[] {
  const stripped = v.split('-')[0] ?? v;
  return stripped.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function defaultIsTty(): boolean {
  return Boolean(process.stdout.isTTY);
}
