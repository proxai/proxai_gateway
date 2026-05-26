import { join } from 'node:path';
import { writeFileAtomic, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

export async function emitRules(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  for (const rule of tree.rules) {
    const body = rule.body.trim();
    // `subpath` preserves any subdir grouping (e.g. `auth/api-key-guard`),
    // so per-tool outputs mirror the ai/rules/ source layout exactly.

    if (cfg.tools.claude) {
      const rel = join(cfg.paths.claudeDir, 'rules', `${rule.subpath}.md`);
      const content = body + '\n';
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.cursor) {
      const rel = join(cfg.paths.cursorDir, 'rules', `${rule.subpath}.mdc`);
      const content = `---\ndescription: ${rule.basename}\nalwaysApply: true\n---\n\n${body}\n`;
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.codex) {
      const rel = join(cfg.paths.codexDir, 'rules', `${rule.subpath}.md`);
      const content = body + '\n';
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.gemini) {
      const rel = join(cfg.paths.geminiDir, 'rules', `${rule.subpath}.md`);
      const content = body + '\n';
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }

    if (cfg.tools.antigravity) {
      const rel = join(cfg.paths.antigravityDir, 'rules', `${rule.subpath}.md`);
      const content = body + '\n';
      await writeFileAtomic(join(repoRoot, rel), content);
      mani.recordEmit(rel, hashOf(content));
    }
  }
}
