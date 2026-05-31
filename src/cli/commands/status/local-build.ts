// Separator-agnostic: a binaryPath can carry either separator on Windows (Bun
// and many tools emit `/`), so matching only the native `node:path.sep` would
// miss `/dist/` on a Windows host. Mirrors the `[/\\]dist[/\\]` regex in
// upgrade.ts so local-build detection agrees across both modules.
const DIST_SEGMENT_RE = /[/\\]dist[/\\]/;

export function isLocalBuildPath(binaryPath: string | undefined): boolean {
  if (binaryPath === undefined) return false;
  return DIST_SEGMENT_RE.test(binaryPath);
}
