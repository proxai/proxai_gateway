import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CODEX_HOME_SUBPATH,
  CODEX_ROLLOUT_GLOB,
  CODEX_STATE_GLOB,
} from 'sources/codex/codex.constants.ts';
import type {
  DiscoveredCodexRolloutFile,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';

export function defaultCodexHome(): string {
  return join(homedir(), CODEX_HOME_SUBPATH);
}

export interface DiscoverCodexOptions {
  minimumMtime?: Date | null;
}

export async function discoverCodexRolloutFiles(
  baseDir: string = defaultCodexHome(),
  options: DiscoverCodexOptions = {},
): Promise<DiscoveredCodexRolloutFile[]> {
  const found: DiscoveredCodexRolloutFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(CODEX_ROLLOUT_GLOB);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    const stat = await statFile(sourcePath);
    if (!stat.exists) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;
    found.push({
      sourcePath,
      sourcePathHash: sha256Hex(sourcePath),
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: stat.mtimeMs,
    });
  }

  return found;
}

export async function discoverCodexStateSqlite(
  baseDir: string = defaultCodexHome(),
  options: DiscoverCodexOptions = {},
): Promise<DiscoveredCodexStateFile | null> {
  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return null;
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const glob = new Bun.Glob(CODEX_STATE_GLOB);
  const candidates: string[] = [];
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    candidates.push(relativePath);
  }
  if (candidates.length === 0) return null;

  const highest = pickHighestNumberedState(candidates);
  if (highest === null) return null;

  const sourcePath = join(baseDir, highest);
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

function pickHighestNumberedState(filenames: string[]): string | null {
  let bestName: string | null = null;
  let bestNumber = -Infinity;
  for (const name of filenames) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (match === null) continue;
    const num = Number(match[1]);
    if (Number.isFinite(num) && num > bestNumber) {
      bestNumber = num;
      bestName = name;
    }
  }
  return bestName;
}
