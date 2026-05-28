import { homedir } from 'node:os';
import { join } from 'node:path';
import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN,
  CLAUDE_DESKTOP_SESSIONS_SUBPATH,
} from 'sources/claude-desktop/claude-desktop.constants.ts';
import type { DiscoveredClaudeDesktopFile } from 'sources/claude-desktop/claude-desktop.types.ts';

export function defaultClaudeDesktopSessionsRoot(): string {
  return join(homedir(), CLAUDE_DESKTOP_SESSIONS_SUBPATH);
}

export interface DiscoverClaudeDesktopOptions {
  minimumMtime?: Date | null;
}

/**
 * Discovers the authoritative File B (audit.jsonl) files inside active Cowork session folders.
 */
export async function discoverClaudeDesktopFiles(
  baseDir: string = defaultClaudeDesktopSessionsRoot(),
  options: DiscoverClaudeDesktopOptions = {},
): Promise<DiscoveredClaudeDesktopFile[]> {
  const found: DiscoveredClaudeDesktopFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN);
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
