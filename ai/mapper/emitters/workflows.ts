import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic, hashOf } from '../safe-fs';
import { commandToGeminiToml } from '../translators/gemini-toml';
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

    if (cfg.tools.claude) {
      const rel = join(cfg.paths.claudeDir, 'commands', `${wf.basename}.md`);
      await writeFileAtomic(join(repoRoot, rel), passthrough);
      mani.recordEmit(rel, passHash);
    }
    if (cfg.tools.cursor) {
      const rel = join(cfg.paths.cursorDir, 'commands', `${wf.basename}.md`);
      await writeFileAtomic(join(repoRoot, rel), passthrough);
      mani.recordEmit(rel, passHash);
    }
    if (cfg.tools.gemini) {
      const toml = commandToGeminiToml({
        name: wf.basename,
        description: asString(wf.frontmatter.description),
        body: wf.body,
      });
      const rel = join(cfg.paths.geminiDir, 'commands', `${wf.basename}.toml`);
      await writeFileAtomic(join(repoRoot, rel), toml);
      mani.recordEmit(rel, hashOf(toml));
    }
    if (cfg.tools.antigravity) {
      const rel = join(cfg.paths.antigravityDir, 'workflows', `${wf.basename}.md`);
      await writeFileAtomic(join(repoRoot, rel), passthrough);
      mani.recordEmit(rel, passHash);
    }
    // Codex: project-scoped prompts deprecated; skip.
  }
}
