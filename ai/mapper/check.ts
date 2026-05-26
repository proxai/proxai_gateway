import { join } from 'node:path';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadConfig } from './config';
import { loadTree } from './loader';
import { Manifest } from './manifest';
import { emitRoot } from './emitters/root';
import { emitRules } from './emitters/rules';
import { emitKnowledge } from './emitters/knowledge';
import { emitSkills } from './emitters/skills';
import { emitAgents } from './emitters/agents';
import { emitWorkflows } from './emitters/workflows';
import { emitTools } from './emitters/tools';

export interface CheckResult {
  added: string[];
  removed: string[];
  changed: string[];
}

export async function runCheck(repoRoot: string): Promise<CheckResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'ai-mapper-check-'));
  try {
    await cp(join(repoRoot, 'ai'), join(scratch, 'ai'), { recursive: true });
    const cfg = await loadConfig(join(scratch, 'ai'));
    const tree = await loadTree(join(scratch, 'ai'));
    const expected = new Manifest(scratch);
    await emitRoot(scratch, tree, cfg, expected, repoRoot);
    await emitRules(scratch, tree, cfg, expected);
    await emitKnowledge(scratch, tree, cfg, expected);
    await emitSkills(scratch, tree, cfg, expected);
    await emitAgents(scratch, tree, cfg, expected);
    await emitWorkflows(scratch, tree, cfg, expected);
    await emitTools(scratch, tree, cfg, expected);

    const old = await Manifest.load(repoRoot);
    const expectedByPath = new Map(expected.files().map((f) => [f.path, f.hash]));
    const oldByPath = new Map(old.files().map((f) => [f.path, f.hash]));

    const added: string[] = [];
    const changed: string[] = [];
    for (const [p, h] of expectedByPath) {
      if (!oldByPath.has(p)) added.push(p);
      else if (oldByPath.get(p) !== h) changed.push(p);
    }
    const removed: string[] = [];
    for (const p of oldByPath.keys()) if (!expectedByPath.has(p)) removed.push(p);

    return { added, removed, changed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
