import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import { SUB_AGENT_CAPTURE_BY_SOURCE } from 'services/config/sub-agent-flags';
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
  captureSubAgents?: boolean;
}

export async function discoverClaudeCodeFiles(
  baseDir: string = defaultClaudeCodeProjectsRoot(),
  options: DiscoverClaudeCodeOptions = {},
): Promise<DiscoveredClaudeCodeFile[]> {
  const found: DiscoveredClaudeCodeFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;
  const captureSubAgents = options.captureSubAgents ?? SUB_AGENT_CAPTURE_BY_SOURCE['claude-code'];

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const seen = new Set<string>();
  await scanGlobInto(found, seen, baseDir, CLAUDE_CODE_GLOB_PATTERN, minMtimeMs);
  if (captureSubAgents) {
    await scanGlobInto(found, seen, baseDir, CLAUDE_CODE_SUBAGENT_GLOB_PATTERN, minMtimeMs);
  }
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
