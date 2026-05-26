import { sep } from 'node:path';

const DIST_SEGMENT = `${sep}dist${sep}`;

export function isLocalBuildPath(binaryPath: string | undefined): boolean {
  if (binaryPath === undefined) return false;
  return binaryPath.includes(DIST_SEGMENT);
}
