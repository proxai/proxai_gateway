import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CLAUDE_CODE_GLOB_PATTERN,
  CLAUDE_CODE_PROJECTS_SUBPATH,
  CLAUDE_CODE_SUBAGENT_GLOB_PATTERN,
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

  // Claude Code transcripts live at two pinned depths under the projects root:
  //   <project>/<sessionId>.jsonl                          ← parent session
  //   <project>/<sessionId>/subagents/agent-<hex>.jsonl    ← sub-agent session
  // Pinned-depth globs (rather than a recursive `**`) match the known on-disk
  // shape exactly; a future Claude Code layout change surfaces as zero new
  // matches rather than silently slurping unexpected files.
  const seen = new Set<string>();
  await scanGlobInto(found, seen, baseDir, CLAUDE_CODE_GLOB_PATTERN, minMtimeMs);
  await scanGlobInto(found, seen, baseDir, CLAUDE_CODE_SUBAGENT_GLOB_PATTERN, minMtimeMs);
  return found;
}

async function scanGlobInto(
  out: DiscoveredClaudeCodeFile[],
  seen: Set<string>,
  baseDir: string,
  pattern: string,
  minMtimeMs: number | null,
): Promise<void> {
  const glob = new Bun.Glob(pattern);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    if (seen.has(sourcePath)) continue;
    const stat = await statFile(sourcePath);
    if (!stat.exists) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;

    seen.add(sourcePath);
    out.push({
      sourcePath,
      sourcePathHash: sha256Hex(sourcePath),
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: stat.mtimeMs,
    });
  }
}
