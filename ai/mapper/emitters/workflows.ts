import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic, hashOf } from '../safe-fs';
import type { AiTree, WorkflowFile } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

function asString(v: unknown, def = ''): string {
  return typeof v === 'string' ? v : def;
}

async function originalText(wf: WorkflowFile, aiRoot: string): Promise<string> {
  return await readFile(join(aiRoot, wf.path), 'utf8');
}

export async function emitWorkflows(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  const aiRoot = join(repoRoot, 'ai');
  for (const wf of tree.workflows) {
    const passthrough = await originalText(wf, aiRoot);
    const passHash = hashOf(passthrough);
    const desc = asString(wf.frontmatter.description);

    // Formulate modern Skill content with YAML frontmatter
    const skillContent = `---
name: ${wf.basename}
description: ${desc}
---

${wf.body}`;

    const skillHash = hashOf(skillContent);

    if (cfg.tools.claude) {
      const rel = join(cfg.paths.claudeDir, 'skills', wf.basename, 'SKILL.md');
      await writeFileAtomic(join(repoRoot, rel), skillContent);
      mani.recordEmit(rel, skillHash);
    }
    if (cfg.tools.cursor) {
      const rel = join(cfg.paths.cursorDir, 'commands', `${wf.basename}.md`);
      await writeFileAtomic(join(repoRoot, rel), passthrough);
      mani.recordEmit(rel, passHash);
    }
    if (cfg.tools.antigravity) {
      // 1. Antigravity IDE Skill (nested SKILL.md)
      const relSkill = join(cfg.paths.antigravityDir, 'skills', wf.basename, 'SKILL.md');
      await writeFileAtomic(join(repoRoot, relSkill), skillContent);
      mani.recordEmit(relSkill, skillHash);

      // 2. Antigravity CLI Command (flat local skill)
      const relCommand = join(cfg.paths.antigravityDir, 'skills', `${wf.basename}.md`);
      await writeFileAtomic(join(repoRoot, relCommand), passthrough);
      mani.recordEmit(relCommand, passHash);
    }
    // Codex: project-scoped prompts deprecated; skip.
  }
}
