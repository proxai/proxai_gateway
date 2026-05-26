#!/usr/bin/env bun
import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';
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
import { runCheck as runCheckImpl } from './check';
import { computeSourceHash, findFirstMissingEmit } from './source-hash';

const args = new Set(process.argv.slice(2));
const mode: 'sync' | 'check' = args.has('--check') ? 'check' : 'sync';
const force = args.has('--force');
const repoRoot = process.cwd();
const aiRoot = join(repoRoot, 'ai');

async function ensureAiDir(): Promise<void> {
  try {
    await stat(aiRoot);
  } catch {
    throw new Error(`Expected ai/ folder at ${aiRoot}. Run from the repo root that owns ai/.`);
  }
}

async function safeWipeStale(current: Manifest, oldMani: Manifest): Promise<number> {
  let removed = 0;
  for (const stale of current.diffStale(oldMani)) {
    try {
      await unlink(join(repoRoot, stale));
      removed++;
    } catch {
      // ignore — already gone
    }
  }
  return removed;
}

async function runSync(): Promise<void> {
  const currentSourceHash = await computeSourceHash(aiRoot);
  const oldMani = await Manifest.load(repoRoot);

  // Fast-skip path: source tree is byte-identical to the last successful sync
  // AND every emitted file is still on disk. The destination spot-check is
  // cheap (`stat` only) and catches manual `rm -rf .claude` / `git clean`
  // scenarios so the user never has to remember `--force`.
  if (!force && oldMani.sourceHash() === currentSourceHash && oldMani.files().length > 0) {
    const missing = await findFirstMissingEmit(
      repoRoot,
      oldMani.files().map((f) => f.path),
    );
    if (missing === null) {
      console.log(
        `ai-mapper: up to date — ${oldMani.files().length} emitted files unchanged since last sync (skip)`,
      );
      return;
    }
    console.log(`ai-mapper: source unchanged but ${missing} is missing — re-syncing`);
  }

  console.log(`ai-mapper: syncing from ${aiRoot}`);
  const cfg = await loadConfig(aiRoot);
  const tree = await loadTree(aiRoot);
  const mani = new Manifest(repoRoot);

  await emitRoot(repoRoot, tree, cfg, mani);
  await emitRules(repoRoot, tree, cfg, mani);
  await emitKnowledge(repoRoot, tree, cfg, mani);
  await emitSkills(repoRoot, tree, cfg, mani);
  await emitAgents(repoRoot, tree, cfg, mani);
  await emitWorkflows(repoRoot, tree, cfg, mani);
  await emitTools(repoRoot, tree, cfg, mani);

  const removed = await safeWipeStale(mani, oldMani);
  mani.setSourceHash(currentSourceHash);
  await mani.save();
  console.log(`ai-mapper: emitted ${mani.files().length} files; removed ${removed} stale`);
}

async function runCheck(): Promise<void> {
  console.log(`ai-mapper: checking ${aiRoot}`);
  const diff = await runCheckImpl(repoRoot);
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) {
    console.log('ai-mapper: no drift');
    return;
  }
  console.error('ai-mapper: DRIFT DETECTED. Run `bun run ai:sync` to regenerate:');
  for (const p of diff.added) console.error(`  + ${p}`);
  for (const p of diff.changed) console.error(`  ~ ${p}`);
  for (const p of diff.removed) console.error(`  - ${p}`);
  process.exit(1);
}

await ensureAiDir();
if (mode === 'check') {
  await runCheck();
} else {
  await runSync();
}
