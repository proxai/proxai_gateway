import { rename } from 'node:fs/promises';
import type { FetchFn } from 'core/utils';
import { setMode } from 'core/io/fs';

export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

export interface ReleaseInfo {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
}

export const RELEASE_API_URL = 'https://api.github.com/repos/proxai/proxai_gateway/releases/latest';
export const FETCH_TIMEOUT_MS = 5_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface FetchReleaseOptions {
  fetch?: FetchFn;
  userAgent: string;
  timeoutMs?: number;
}

export async function fetchLatestRelease(options: FetchReleaseOptions): Promise<ReleaseInfo> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': options.userAgent,
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

export function expectedAssetName(platform: NodeJS.Platform, arch: string): string {
  const ext = platform === 'win32' ? '.exe' : '';
  return `proxai-gateway-${platform}-${arch}${ext}`;
}

export function findAssetForPlatform(
  release: ReleaseInfo,
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | undefined {
  const name = expectedAssetName(platform, arch);
  return release.assets.find((a) => a.name === name);
}

export interface DownloadAssetOptions {
  fetch?: FetchFn;
  userAgent: string;
  timeoutMs?: number;
}

export async function downloadAsset(
  url: string,
  options: DownloadAssetOptions,
): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': options.userAgent,
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

export interface ReplaceBinaryResult {
  stagedSibling: string | null;
}

export async function replaceBinary(
  binaryPath: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
): Promise<ReplaceBinaryResult> {
  const staged = `${binaryPath}.new`;
  if (platform === 'win32') {
    await Bun.write(staged, bytes);
    return { stagedSibling: staged };
  }
  await Bun.write(staged, bytes);
  await setMode(staged, 0o755);
  await rename(staged, binaryPath);
  return { stagedSibling: null };
}
