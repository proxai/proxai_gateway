export interface VersionCheckDeps {
  currentVersion: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface VersionCheckResult {
  latestVersion: string;
  hasUpdate: boolean;
  checkedAt: string;
  assetUrl?: string;
}

export type VersionCheckOutcome =
  | { kind: 'ok'; result: VersionCheckResult }
  | { kind: 'no_release'; reason: string }
  | { kind: 'error'; reason: string };

const RELEASE_API_URL = 'https://api.github.com/repos/proxai/proxai_gateway/releases/latest';
const REQUEST_TIMEOUT_MS = 5000;

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface ReleaseInfo {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
}

export async function checkLatestVersion(deps: VersionCheckDeps): Promise<VersionCheckOutcome> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let body: ReleaseInfo;
  try {
    const res = await fetchFn(RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'proxai-gateway-version-check',
      },
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      return { kind: 'no_release', reason: 'github returned 404 (no published releases for repo)' };
    }
    if (!res.ok) {
      return { kind: 'error', reason: `github returned ${res.status.toString()}` };
    }
    body = (await res.json()) as ReleaseInfo;
  } catch (err) {
    return {
      kind: 'error',
      reason: err instanceof Error ? `request failed: ${err.message}` : 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }

  if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) {
    return { kind: 'error', reason: 'release payload missing tag_name or assets array' };
  }

  const latestVersion = stripV(body.tag_name);
  if (latestVersion.length === 0) {
    return { kind: 'error', reason: 'release tag_name is empty after stripping v prefix' };
  }

  const hasUpdate = compareVersionStrings(latestVersion, deps.currentVersion) > 0;

  const arch = process.arch;
  const platform = process.platform;
  const ext = platform === 'win32' ? '.exe' : '';
  const expectedAssetName = `proxai-gateway-${platform}-${arch}${ext}`;
  const asset = body.assets.find((a) => a.name === expectedAssetName);

  const result: VersionCheckResult = {
    latestVersion,
    hasUpdate,
    checkedAt: now().toISOString(),
  };
  if (asset !== undefined) {
    result.assetUrl = asset.browser_download_url;
  }
  return { kind: 'ok', result };
}

function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

function compareVersionStrings(a: string, b: string): number {
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
