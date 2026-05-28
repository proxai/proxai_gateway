import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { copyDirRecursive, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

const TOOLS = ['claude', 'cursor', 'codex', 'antigravity'] as const;
type Tool = (typeof TOOLS)[number];

function skillsBaseDir(repoRoot: string, cfg: MapperConfig, tool: Tool): string {
  if (tool === 'codex') {
    return join(repoRoot, '.agents', 'skills');
  }
  const dirs: Record<Exclude<Tool, 'codex'>, string> = {
    claude: cfg.paths.claudeDir,
    cursor: cfg.paths.cursorDir,
    antigravity: cfg.paths.antigravityDir,
  };
  return join(repoRoot, dirs[tool], 'skills');
}

function manifestPrefix(cfg: MapperConfig, tool: Tool): string {
  if (tool === 'codex') return '.agents';
  const dirs: Record<Exclude<Tool, 'codex'>, string> = {
    claude: cfg.paths.claudeDir,
    cursor: cfg.paths.cursorDir,
    antigravity: cfg.paths.antigravityDir,
  };
  return dirs[tool];
}

export async function emitSkills(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  for (const tool of TOOLS) {
    if (!cfg.tools[tool]) continue;
    const base = skillsBaseDir(repoRoot, cfg, tool);
    const prefix = manifestPrefix(cfg, tool);
    for (const skill of tree.skills) {
      const dst = join(base, skill.name);
      const files = await copyDirRecursive(skill.rootDir, dst);
      for (const rel of files) {
        const abs = join(dst, rel);
        const content = await readFile(abs, 'utf8').catch(() => '');
        mani.recordEmit(join(prefix, 'skills', skill.name, rel), hashOf(content));
      }
    }
  }
}
