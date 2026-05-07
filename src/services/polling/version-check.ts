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

export async function checkLatestVersion(
  deps: VersionCheckDeps,
): Promise<VersionCheckResult | null> {
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
    if (!res.ok) return null;
    body = (await res.json()) as ReleaseInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) {
    return null;
  }

  const latestVersion = stripV(body.tag_name);
  if (latestVersion.length === 0) return null;

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
  return result;
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
