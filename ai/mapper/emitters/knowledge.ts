import { join } from 'node:path';
import { writeFileAtomic, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

/**
 * Emits each knowledge file verbatim into every enabled tool's
 * `<tool_dir>/knowledge/<subpath>.md`. Mirrors the rules emitter pattern —
 * subpath preserves the source's directory layout so a file at
 * `ai/knowledge/api/route-map.md` becomes `.claude/knowledge/api/route-map.md`.
 *
 * Knowledge bodies are NOT inlined into root files anymore. The root emitter
 * builds a thin index pointing at these on-disk files; agents read on demand.
 * Before this split, every root doc (CLAUDE.md / AGENTS.md / GEMINI.md /
 * .agent/AGENTS.md) carried the full 1.2M+ char concatenation of all
 * knowledge bodies, which made Claude Code hang ~2 min on cold start.
 */
export async function emitKnowledge(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  for (const k of tree.knowledge) {
    const body = k.body.trim();
    const content = body + '\n';

    if (cfg.tools.claude) {
      const rel = join(cfg.paths.claudeDir, 'knowledge', `${k.subpath}.md`);
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.cursor) {
      const rel = join(cfg.paths.cursorDir, 'knowledge', `${k.subpath}.md`);
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.codex) {
      const rel = join(cfg.paths.codexDir, 'knowledge', `${k.subpath}.md`);
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.antigravity) {
      const rel = join(cfg.paths.antigravityDir, 'knowledge', `${k.subpath}.md`);
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }
  }
}
