import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CURSOR_GLOBAL_DB_RELATIVE,
  CURSOR_USER_SUBPATH,
  CURSOR_WORKSPACE_GLOB,
} from 'sources/cursor/cursor.constants.ts';
import type { DiscoveredCursorFile } from 'sources/cursor/cursor.types.ts';

export function defaultCursorUserRoot(): string {
  return join(homedir(), CURSOR_USER_SUBPATH);
}

export interface DiscoverCursorOptions {
  /**
   * Skip files whose mtime is older than this Date. When `null` or omitted,
   * no cap is applied. The poller passes a value only on a fresh install
   * (no cursors yet); once cursors exist, those positions become the lower
   * bound and the cap is skipped.
   */
  minimumMtime?: Date | null;
}

export async function discoverCursorFiles(
  baseDir: string = defaultCursorUserRoot(),
  options: DiscoverCursorOptions = {},
): Promise<DiscoveredCursorFile[]> {
  const found: DiscoveredCursorFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const globalPath = join(baseDir, CURSOR_GLOBAL_DB_RELATIVE);
  const globalEntry = await tryDescribe(globalPath, minMtimeMs);
  if (globalEntry !== null) found.push(globalEntry);

  const glob = new Bun.Glob(CURSOR_WORKSPACE_GLOB);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    const entry = await tryDescribe(sourcePath, minMtimeMs);
    if (entry !== null) found.push(entry);
  }

  return found;
}

async function tryDescribe(
  sourcePath: string,
  minMtimeMs: number | null,
): Promise<DiscoveredCursorFile | null> {
  const stat = await statFile(sourcePath);
  if (!stat.exists) return null;
  if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) return null;
  return {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}
