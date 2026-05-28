import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic, hashOf } from '../safe-fs';
import { subagentToCodexToml } from '../translators/codex-toml';
import type { AiTree, Agent } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';
import type { FrontmatterValue } from '../frontmatter';

function asString(v: FrontmatterValue | undefined, def = ''): string {
  return typeof v === 'string' ? v : def;
}

function asStringArray(v: FrontmatterValue | undefined): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

async function originalText(agent: Agent, aiRoot: string): Promise<string> {
  return await readFile(join(aiRoot, agent.path), 'utf8');
}

export async function emitAgents(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
): Promise<void> {
  for (const agent of tree.agents) {
    const aiRoot = join(repoRoot, 'ai');
    const passthrough = await originalText(agent, aiRoot);
    const passHash = hashOf(passthrough);

    interface Target {
      rel: string;
      content: string;
      hash: string;
    }
    const targets: Target[] = [];

    if (cfg.tools.claude) {
      const rel = join(cfg.paths.claudeDir, 'agents', `${agent.basename}.md`);
      targets.push({ rel, content: passthrough, hash: passHash });
    }
    if (cfg.tools.cursor) {
      const rel = join(cfg.paths.cursorDir, 'agents', `${agent.basename}.md`);
      targets.push({ rel, content: passthrough, hash: passHash });
    }
    if (cfg.tools.codex) {
      const modelStr = asString(agent.frontmatter.model);
      const toml = subagentToCodexToml({
        name: asString(agent.frontmatter.name, agent.basename),
        description: asString(agent.frontmatter.description),
        tools: asStringArray(agent.frontmatter.tools),
        model: modelStr !== '' ? modelStr : undefined,
        body: agent.body,
      });
      const rel = join(cfg.paths.codexDir, 'agents', `${agent.basename}.toml`);
      targets.push({ rel, content: toml, hash: hashOf(toml) });
    }

    for (const t of targets) {
      await writeFileAtomic(join(repoRoot, t.rel), t.content);
      mani.recordEmit(t.rel, t.hash);
    }
  }
}
