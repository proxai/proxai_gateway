import { join, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { writeFileAtomic, hashOf } from '../safe-fs';
import type { AiTree } from '../loader';
import type { MapperConfig } from '../config';
import type { Manifest } from '../manifest';

async function repoHasDocs(repoRoot: string): Promise<boolean> {
  try {
    const s = await stat(join(repoRoot, 'docs'));
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function generateFileTree(repoRoot: string, maxDepth = 3): Promise<string> {
  let files: string[];
  try {
    const proc = Bun.spawn(['git', 'ls-files'], {
      cwd: repoRoot,
      stdout: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error('not a git repo');
    files = output.trim().split('\n').filter(Boolean);
  } catch {
    return '(file tree unavailable — not a git repo)';
  }

  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < Math.min(parts.length, maxDepth + 1); i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  const sorted = Array.from(dirs).toSorted();
  const lines: string[] = [`${basename(repoRoot)}/`];
  for (const d of sorted) {
    const depth = d.split('/').length;
    const parts = d.split('/');
    const name = parts[parts.length - 1] ?? d;
    lines.push(`${'  '.repeat(depth)}${name}/`);
  }
  return lines.join('\n');
}

function buildPreamble(tree: AiTree): string {
  return tree.preamble.trim();
}

function buildRepoStructureSection(fileTree: string): string {
  return `## Repository structure\n\n\`\`\`\n${fileTree}\n\`\`\``;
}

/**
 * First non-empty line of the body, with leading `#` / `##` markers stripped.
 * Used as the row description in the knowledge index. Falls back to the
 * basename when the body is empty or unparseable.
 */
function firstNonEmptyLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    return line.replace(/^#+\s*/, '').trim();
  }
  return '';
}

/**
 * Replaces the old `buildKnowledgeSection` (which inlined every knowledge
 * body into the root doc, producing 1.2M-char CLAUDE.md files that froze
 * Claude Code on cold start). The index lists one row per knowledge file
 * pointing at `<toolDir>/knowledge/<subpath>.md` so the agent can Read
 * exactly the topic it needs.
 *
 * When two tools share a root file (Codex + Cursor → AGENTS.md), pass the
 * canonical tool dir and pair the index with a footer note about the mirror.
 */
function buildKnowledgeIndex(tree: AiTree, toolDir: string): string {
  if (tree.knowledge.length === 0) return '';
  const rows = tree.knowledge.map((k) => {
    const rel = `${toolDir}/knowledge/${k.subpath}.md`;
    const desc = firstNonEmptyLine(k.body) || k.basename;
    return `| \`${rel}\` | ${desc} |`;
  });
  return [
    '## Domain knowledge index',
    '',
    "Niche project facts, design rationale, and gotchas that don't fit in `docs/`. Each row below is a separate file on disk — use the Read tool to load **only** the topics relevant to your current task. Do NOT batch-read the whole list; bodies are kept out of this doc to keep startup fast.",
    '',
    '| Path | Topic |',
    '| --- | --- |',
    ...rows,
  ].join('\n');
}

function buildDocsSection(hasDocs: boolean): string {
  if (!hasDocs) return '';
  return `## Project documentation

Read \`docs/\` at the repo root for subsystem-level documentation, architecture references, and design specs. For broader/standard project documentation, look there first. The mapper does NOT copy \`docs/\` — it lives at the repo root unchanged.`;
}

function buildExtendingMemorySection(): string {
  return `## Extending the AI memory

When you learn something new about this project, or when the user asks you to "remember this" / "save this to memory" / "add this as a rule", **enhance the \`ai/\` source folder** — it is the single source of truth that propagates to every LLM via the mapper.

Decision tree for what to add:

1. **A new must-do / must-not-do directive** → append to or create a file under \`ai/rules/<topic>.md\`. Plain markdown body, no frontmatter.
2. **A new niche code-specific gotcha, design-system note, or product-decision rationale that doesn't belong in \`docs/\`** → append to or create a file under \`ai/knowledge/<topic>.md\`. Plain markdown body, no frontmatter. The mapper auto-indexes it into every tool's root doc and copies the body to \`.<tool>/knowledge/<topic>.md\` for on-demand Read.
3. **A new reusable, named procedure (skill)** → create \`ai/skills/<name>/SKILL.md\` with YAML frontmatter (\`name\`, \`description\`) and any supporting files in the same folder.
4. **A new slash-command prompt template (workflow)** → create \`ai/workflows/<name>.md\` with optional frontmatter \`description\` and the prompt as body.
5. **A new named agent persona** → create \`ai/agents/<name>.md\` with frontmatter (\`name\`, \`description\`, \`tools\`, \`model\`) and the system prompt as body.
6. **A new helper script** → drop the file in \`ai/tools/\`.

After editing \`ai/\`, run \`bun run ai/mapper/index.ts\` to redistribute changes to every per-tool directory. **Never edit files inside \`.<tool>/\` directly** — they are regenerated by the mapper and your changes will be overwritten.

For the full mapping spec and reasoning, see \`ai/mapper/README.md\`.`;
}

async function composeForClaude(fileTree: string, tree: AiTree, hasDocs: boolean): Promise<string> {
  const orchestrationSection = `## Your orchestration (Claude Code)

This repo uses an \`ai/\` folder as the single source of truth for AI artifacts. The mapper generates Claude-specific files into \`.claude/\`:

- **Rules:** \`.claude/rules/*.md\` — one file per rule topic; Claude auto-loads all \`.md\` files in this folder
- **Knowledge:** \`.claude/knowledge/*.md\` — niche project facts indexed in the **Domain knowledge index** below; **NOT auto-loaded** — use the Read tool to load only the topics your current task needs
- **Skills:** \`.claude/skills/<name>/SKILL.md\` — invokable skill packages
- **Subagents:** \`.claude/agents/<name>.md\` — named agent personas
- **Slash commands:** \`.claude/commands/<name>.md\` — prompt templates invoked via \`/name\`
- **Helper scripts:** \`.claude/tools/*\` — shared utility scripts callable from skills/agents/commands

See \`ai/mapper/README.md\` for full mapping details.`;

  const parts: string[] = [buildPreamble(tree), buildRepoStructureSection(fileTree)];

  const docsSection = buildDocsSection(hasDocs);
  if (docsSection) parts.push(docsSection);

  parts.push(orchestrationSection);
  parts.push(buildExtendingMemorySection());

  const knowledge = buildKnowledgeIndex(tree, '.claude');
  if (knowledge) parts.push(knowledge);

  return parts.join('\n\n') + '\n';
}

async function composeForAgentsMD(
  fileTree: string,
  tree: AiTree,
  hasDocs: boolean,
  cfg: MapperConfig,
): Promise<string> {
  const orchestrationSection = `## Your orchestration

This file (\`AGENTS.md\`) is read by both Codex CLI and Cursor. Each has its own artifact locations:

### Codex CLI

- **Rules:** \`.codex/rules/*.md\` — one file per rule topic. **Codex does not auto-load this folder**; read each file via the Read tool to load project rules into context.
- **Knowledge:** \`.codex/knowledge/*.md\` — see **Domain knowledge index** below; use the Read tool to load only the topics relevant to your current task.
- **Skills:** \`.agents/skills/<name>/SKILL.md\` ⚠️ Note: PLURAL \`.agents/\` at repo root (not \`.codex/skills/\`). This is Codex's special path.
- **Subagents:** \`.codex/agents/<name>.toml\`
- **Helper scripts:** \`.codex/tools/*\`

### Cursor

- **Rules:** \`.cursor/rules/*.mdc\` (with \`alwaysApply: true\` frontmatter) — Cursor auto-loads all \`.mdc\` files in this folder
- **Knowledge:** \`.cursor/knowledge/*.md\` — identical content to \`.codex/knowledge/\`; the index below lists \`.codex/\` paths as the canonical reference, but the same files exist under \`.cursor/knowledge/\` if you prefer to read from your own tool dir.
- **Skills:** \`.cursor/skills/<name>/SKILL.md\`
- **Subagents:** \`.cursor/agents/<name>.md\`
- **Slash commands:** \`.cursor/commands/<name>.md\`
- **Helper scripts:** \`.cursor/tools/*\`

See \`ai/mapper/README.md\` for full mapping details.`;

  const parts: string[] = [buildPreamble(tree), buildRepoStructureSection(fileTree)];

  const docsSection = buildDocsSection(hasDocs);
  if (docsSection) parts.push(docsSection);

  parts.push(orchestrationSection);
  parts.push(buildExtendingMemorySection());

  // AGENTS.md is shared by Codex + Cursor. Index uses the canonical Codex path
  // when Codex is enabled; otherwise falls back to Cursor. Cursor users can
  // also read the same files at `.cursor/knowledge/` (emitter writes to both).
  const indexToolDir = cfg.tools.codex ? '.codex' : cfg.tools.cursor ? '.cursor' : '.codex';
  const knowledge = buildKnowledgeIndex(tree, indexToolDir);
  if (knowledge) parts.push(knowledge);

  return parts.join('\n\n') + '\n';
}

async function composeForGemini(fileTree: string, tree: AiTree, hasDocs: boolean): Promise<string> {
  const orchestrationSection = `## Your orchestration (Gemini CLI)

This repo uses an \`ai/\` folder as the single source of truth for AI artifacts. The mapper generates Gemini-specific files into \`.gemini/\`:

- **Rules:** \`.gemini/rules/*.md\` — one file per rule topic. **Gemini does not auto-load this folder**; read each file via the Read tool to load project rules into context.
- **Knowledge:** \`.gemini/knowledge/*.md\` — see **Domain knowledge index** below; use the Read tool to load only the topics relevant to your current task.
- **Skills:** \`.gemini/skills/<name>/SKILL.md\`
- **Subagents:** \`.gemini/agents/<name>.md\`
- **Slash commands:** \`.gemini/commands/<name>.toml\` (TOML format — same template, different syntax)
- **Helper scripts:** \`.gemini/tools/*\`

See \`ai/mapper/README.md\` for full mapping details.`;

  const parts: string[] = [buildPreamble(tree), buildRepoStructureSection(fileTree)];

  const docsSection = buildDocsSection(hasDocs);
  if (docsSection) parts.push(docsSection);

  parts.push(orchestrationSection);
  parts.push(buildExtendingMemorySection());

  const knowledge = buildKnowledgeIndex(tree, '.gemini');
  if (knowledge) parts.push(knowledge);

  return parts.join('\n\n') + '\n';
}

async function composeForAntigravity(
  fileTree: string,
  tree: AiTree,
  hasDocs: boolean,
): Promise<string> {
  const orchestrationSection = `## Your orchestration (Antigravity)

This repo uses an \`ai/\` folder as the single source of truth for AI artifacts. The mapper generates Antigravity-specific files into \`.agent/\`:

- **Rules:** \`.agent/rules/*.md\` — one file per rule topic; Antigravity auto-loads all \`.md\` files in this folder
- **Knowledge:** \`.agent/knowledge/*.md\` — niche project facts indexed in the **Domain knowledge index** below; **NOT auto-loaded** — use the Read tool to load only the topics your current task needs
- **Skills:** \`.agent/skills/<name>/SKILL.md\`
- **Workflows:** \`.agent/workflows/<name>.md\` (slash-triggered prompt templates, invoked via \`/<workflow-name>\`)
- **Helper scripts:** \`.agent/tools/*\`

See \`ai/mapper/README.md\` for full mapping details.`;

  const parts: string[] = [buildPreamble(tree), buildRepoStructureSection(fileTree)];

  const docsSection = buildDocsSection(hasDocs);
  if (docsSection) parts.push(docsSection);

  parts.push(orchestrationSection);
  parts.push(buildExtendingMemorySection());

  const knowledge = buildKnowledgeIndex(tree, '.agent');
  if (knowledge) parts.push(knowledge);

  return parts.join('\n\n') + '\n';
}

export async function emitRoot(
  repoRoot: string,
  tree: AiTree,
  cfg: MapperConfig,
  mani: Manifest,
  /**
   * Optional override for where to read repo metadata from. The mapper writes
   * outputs to `repoRoot`, but `--check` mode runs against a scratch directory
   * that has no `.git/` or real `docs/`. To keep file-tree + docs detection
   * stable across sync and check, callers can pass `sourceRoot = realRepoRoot`.
   * Defaults to `repoRoot` (the normal sync case).
   */
  sourceRoot: string = repoRoot,
): Promise<void> {
  const [fileTree, hasDocs] = await Promise.all([
    generateFileTree(sourceRoot),
    repoHasDocs(sourceRoot),
  ]);

  if (cfg.tools.claude) {
    const doc = await composeForClaude(fileTree, tree, hasDocs);
    const h = hashOf(doc);
    await writeFileAtomic(join(repoRoot, 'CLAUDE.md'), doc);
    mani.recordEmit('CLAUDE.md', h);
  }

  const needsAgentsMd = cfg.tools.codex || cfg.tools.cursor;
  if (needsAgentsMd) {
    const doc = await composeForAgentsMD(fileTree, tree, hasDocs, cfg);
    const h = hashOf(doc);
    await writeFileAtomic(join(repoRoot, 'AGENTS.md'), doc);
    mani.recordEmit('AGENTS.md', h);
  }

  if (cfg.tools.gemini) {
    const doc = await composeForGemini(fileTree, tree, hasDocs);
    const h = hashOf(doc);
    await writeFileAtomic(join(repoRoot, 'GEMINI.md'), doc);
    mani.recordEmit('GEMINI.md', h);
  }

  if (cfg.tools.antigravity) {
    const doc = await composeForAntigravity(fileTree, tree, hasDocs);
    const h = hashOf(doc);
    const rel = join(cfg.paths.antigravityDir, 'AGENTS.md');
    await writeFileAtomic(join(repoRoot, rel), doc);
    mani.recordEmit(rel, h);
  }
}
