const DIST_SEGMENT_RE = /[/\\]dist[/\\]/;

export function isLocalBuildPath(binaryPath: string | undefined): boolean {
  if (binaryPath === undefined) return false;
  return DIST_SEGMENT_RE.test(binaryPath);
}
