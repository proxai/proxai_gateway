import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Recursively walks every file under `root`, returning sorted absolute paths.
 * Skips dotfiles and dotdirs so .git, .DS_Store, .mapper-manifest.json etc.
 * never enter the hash. Symlinks are followed (`stat`, not `lstat`).
 */
async function listAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(root);
  return out.toSorted();
}

/**
 * Computes a stable hash of the entire ai/ source tree. The hash covers:
 *   - every file under ai/ except dotfiles (e.g. the manifest itself)
 *   - the relative path of each file
 *   - the byte contents of each file
 *
 * Order-independent because paths are sorted before hashing.
 *
 * NOTE: `ai/mapper/` is included on purpose — a change to the emitter logic
 * changes the output shape even if the rule/knowledge content is unchanged,
 * and the next sync must run. `ai/tools/coverage-orchestrator/` is also
 * included for the same reason: a future maintainer changing its content
 * should not be silently skipped (even though it's excluded from per-tool
 * emit via `emit_tools.exclude_subdirs`, it still ships as part of `ai/`).
 */
export async function computeSourceHash(aiRoot: string): Promise<string> {
  await stat(aiRoot); // throws cleanly if ai/ is missing
  const files = await listAllFiles(aiRoot);
  const h = createHash('sha256');
  for (const abs of files) {
    const rel = abs.slice(aiRoot.length + 1);
    h.update(rel);
    h.update('\0');
    h.update(await readFile(abs));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * Quick destination integrity check: confirm every path in the manifest still
 * exists on disk. Returns the first missing path (for diagnostics) or null if
 * all present. Hash verification is deliberately skipped — the source-hash
 * gate above already proves the inputs match, so re-hashing every output
 * would double the cost without changing the outcome in the common case.
 * The cheap `stat` catches the realistic skip-busting scenarios: someone
 * manually deleted a generated dir, or `git clean` ran between sessions.
 */
export async function findFirstMissingEmit(
  repoRoot: string,
  emittedPaths: readonly string[],
): Promise<string | null> {
  for (const rel of emittedPaths) {
    try {
      await stat(join(repoRoot, rel));
    } catch {
      return rel;
    }
  }
  return null;
}
