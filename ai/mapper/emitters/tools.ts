import { join } from 'node:path';
import { stat, readFile, readdir } from 'node:fs/promises';
import { copyDirRecursive, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

const TOOL_DIRS = ['claude', 'codex', 'cursor', 'antigravity'] as const;
type ToolKey = (typeof TOOL_DIRS)[number];

function toolDir(cfg: MapperConfig, tool: ToolKey): string {
  return {
    claude: cfg.paths.claudeDir,
    cursor: cfg.paths.cursorDir,
    codex: cfg.paths.codexDir,
    antigravity: cfg.paths.antigravityDir,
  }[tool];
}

export async function emitTools(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  try {
    await stat(tree.tools.rootDir);
  } catch {
    return;
  }

  // Top-level entries under ai/tools/ — files copy as-is; subdirectories
  // are filtered against emit_tools.exclude_subdirs (used for in-repo
  // infrastructure like a coverage orchestrator that should be invoked
  // in-place via package.json scripts, not duplicated into every
  // per-tool .X/tools/ directory).
  const excluded = new Set(cfg.emitTools.excludeSubdirs);
  const topEntries = await readdir(tree.tools.rootDir, { withFileTypes: true });

  for (const tool of TOOL_DIRS) {
    if (!cfg.tools[tool]) continue;
    const dst = join(repoRoot, toolDir(cfg, tool), 'tools');
    for (const entry of topEntries) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const srcAbs = join(tree.tools.rootDir, entry.name);
      const dstAbs = join(dst, entry.name);
      if (entry.isDirectory()) {
        const files = await copyDirRecursive(srcAbs, dstAbs);
        for (const rel of files) {
          const content = await readFile(join(dstAbs, rel), 'utf8').catch(() => '');
          mani.recordEmit(join(toolDir(cfg, tool), 'tools', entry.name, rel), hashOf(content));
        }
      } else if (entry.isFile()) {
        const { copyFile, mkdir } = await import('node:fs/promises');
        await mkdir(dst, { recursive: true });
        await copyFile(srcAbs, dstAbs);
        const content = await readFile(dstAbs, 'utf8').catch(() => '');
        mani.recordEmit(join(toolDir(cfg, tool), 'tools', entry.name), hashOf(content));
      }
    }
  }
}
