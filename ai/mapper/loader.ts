import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname, sep } from 'node:path';
import { parseFrontmatter, type FrontmatterData } from './frontmatter';

export interface RuleFile {
  path: string;
  basename: string;
  /**
   * Path under `rules/` with the .md extension stripped — preserves any
   * subdirectory grouping (e.g. `auth/api-key-guard`). Equal to `basename`
   * when the rule lives directly under `rules/`. Used by emitters so per-tool
   * outputs mirror the source layout (`.claude/rules/auth/api-key-guard.md`).
   */
  subpath: string;
  body: string;
}

export interface KnowledgeFile {
  path: string;
  basename: string;
  /** Path under `knowledge/` with .md stripped; see RuleFile.subpath. */
  subpath: string;
  body: string;
}

export interface WorkflowFile {
  path: string;
  basename: string;
  frontmatter: FrontmatterData;
  body: string;
}

export interface Skill {
  name: string;
  rootDir: string;
}

export interface Agent {
  path: string;
  basename: string;
  frontmatter: FrontmatterData;
  body: string;
}

export interface ToolsDir {
  rootDir: string;
}

export interface AiTree {
  preamble: string;
  rules: RuleFile[];
  knowledge: KnowledgeFile[];
  workflows: WorkflowFile[];
  skills: Skill[];
  agents: Agent[];
  tools: ToolsDir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listMd(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  }
  await walk(dir);
  return out.toSorted();
}

function relUnder(absPath: string, parentDir: string): string {
  return absPath
    .slice(parentDir.length + 1)
    .split(sep)
    .join('/');
}

function subpathUnder(absPath: string, parentDir: string): string {
  // strip the parentDir prefix + leading sep, normalize Windows backslashes
  // to forward slashes (subpath is a logical doc path used in markdown
  // references and the manifest, not an OS filesystem path), then strip
  // the .md extension
  const rel = relUnder(absPath, parentDir);
  return rel.endsWith('.md') ? rel.slice(0, -3) : rel;
}

async function loadMdPlain(
  absPath: string,
  aiRoot: string,
  parentDir: string,
): Promise<KnowledgeFile> {
  const body = await readFile(absPath, 'utf8');
  return {
    path: relUnder(absPath, aiRoot),
    basename: basename(absPath, extname(absPath)),
    subpath: subpathUnder(absPath, parentDir),
    body,
  };
}

async function loadMdWithFrontmatter(absPath: string, aiRoot: string): Promise<WorkflowFile> {
  const raw = await readFile(absPath, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  return {
    path: relUnder(absPath, aiRoot),
    basename: basename(absPath, extname(absPath)),
    frontmatter: data,
    body,
  };
}

export async function loadTree(aiRoot: string): Promise<AiTree> {
  const preamblePath = join(aiRoot, 'AGENTS.md');
  const preamble = (await exists(preamblePath)) ? await readFile(preamblePath, 'utf8') : '';

  const rulesRoot = join(aiRoot, 'rules');
  const rulesPaths = await listMd(rulesRoot);
  const rules: RuleFile[] = await Promise.all(
    rulesPaths.map(async (p) => {
      const body = await readFile(p, 'utf8');
      return {
        path: relUnder(p, aiRoot),
        basename: basename(p, extname(p)),
        subpath: subpathUnder(p, rulesRoot),
        body,
      };
    }),
  );

  const knowledgeRoot = join(aiRoot, 'knowledge');
  const knowledgePaths = await listMd(knowledgeRoot);
  const knowledge = await Promise.all(
    knowledgePaths.map((p) => loadMdPlain(p, aiRoot, knowledgeRoot)),
  );

  const workflowsPaths = await listMd(join(aiRoot, 'workflows'));
  const workflows = await Promise.all(workflowsPaths.map((p) => loadMdWithFrontmatter(p, aiRoot)));

  const skillsRoot = join(aiRoot, 'skills');
  const skills: Skill[] = [];
  if (await exists(skillsRoot)) {
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        skills.push({ name: e.name, rootDir: join(skillsRoot, e.name) });
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  const agentPaths = await listMd(join(aiRoot, 'agents'));
  const agents = await Promise.all(agentPaths.map((p) => loadMdWithFrontmatter(p, aiRoot)));

  const toolsRootDir = join(aiRoot, 'tools');
  const tools: ToolsDir = { rootDir: toolsRootDir };

  return { preamble, rules, knowledge, workflows, skills, agents, tools };
}
