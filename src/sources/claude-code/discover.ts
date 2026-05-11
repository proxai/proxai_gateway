import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CLAUDE_CODE_GLOB_PATTERN,
  CLAUDE_CODE_PROJECTS_SUBPATH,
} from 'sources/claude-code/claude-code.constants.ts';
import type { DiscoveredClaudeCodeFile } from 'sources/claude-code/claude-code.types.ts';

export function defaultClaudeCodeProjectsRoot(): string {
  return join(homedir(), CLAUDE_CODE_PROJECTS_SUBPATH);
}

export interface DiscoverClaudeCodeOptions {
  minimumMtime?: Date | null;
}

export async function discoverClaudeCodeFiles(
  baseDir: string = defaultClaudeCodeProjectsRoot(),
  options: DiscoverClaudeCodeOptions = {},
): Promise<DiscoveredClaudeCodeFile[]> {
  const found: DiscoveredClaudeCodeFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(CLAUDE_CODE_GLOB_PATTERN);

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
