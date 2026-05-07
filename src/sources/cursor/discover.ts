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
