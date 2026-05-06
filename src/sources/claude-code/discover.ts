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
  /**
   * Skip files whose mtime is older than this Date. When `null` or omitted,
   * no cap is applied. The poller passes a value only on a fresh install
   * (no cursors yet); once cursors exist, those positions become the lower
   * bound and the cap is skipped.
   */
  minimumMtime?: Date | null;
}

export async function discoverClaudeCodeFiles(
  baseDir: string = defaultClaudeCodeProjectsRoot(),
  options: DiscoverClaudeCodeOptions = {},
): Promise<DiscoveredClaudeCodeFile[]> {
  const found: DiscoveredClaudeCodeFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  if (!(await Bun.file(baseDir).exists())) {
    const stat = await statFile(baseDir);
    if (!stat.exists) return found;
  }

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
