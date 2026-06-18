// src/services/exclusion/match.ts
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * realpathSync, but when the leaf does not exist it resolves the deepest EXISTING ancestor
 * (so a symlinked PARENT still canonicalizes) and re-appends the non-existent tail. Never
 * throws — returns the lexical input if nothing resolves.
 */
function realpathOfDeepestExisting(p: string): string {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.toReversed());
    } catch {
      const parent = dirname(current);
      if (parent === current) return p; // reached root unresolved -> lexical fallback
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Canonicalize a folder path for comparison. Idempotent: safe to call on its own output.
 * Steps: trim -> expand leading ~ -> resolve symlinks (realpathSync, ENOENT-tolerant)
 * -> strip trailing slashes -> lowercase on case-insensitive filesystems.
 * Never throws (a non-existent path falls back to its lexical form).
 */
export function normalizeFolderPath(input: string): string {
  let out = input.trim();
  // Empty/whitespace input must NOT fall through to realpathSync(''), which resolves to the
  // daemon's process.cwd() — that would silently turn a junk cwd into "wherever the daemon runs".
  if (out.length === 0) return '';
  if (out === '~') out = homedir();
  else if (out.startsWith('~/')) out = join(homedir(), out.slice(2));
  // Resolve symlinks. If the leaf doesn't exist, resolve the deepest existing ancestor so a
  // symlinked PARENT still canonicalizes (realpathSync alone would throw and lose it).
  out = realpathOfDeepestExisting(out);
  out = out.replace(/\/+$/, '');
  if (CASE_INSENSITIVE_FS) out = out.toLowerCase();
  return out;
}

/** True if `folderPath` equals, or is nested under, any excluded path (path-boundary anchored). */
export function isProjectExcluded(folderPath: string, excludedPaths: readonly string[]): boolean {
  if (excludedPaths.length === 0) return false;
  const folder = normalizeFolderPath(folderPath);
  for (const raw of excludedPaths) {
    if (raw.trim().length === 0) continue; // guard the raw entry, before normalization
    const prefix = normalizeFolderPath(raw);
    if (folder === prefix || folder.startsWith(prefix + '/')) return true;
  }
  return false;
}

/**
 * Stable, filesystem-independent canonicalization for CHANGE DETECTION (e.g. the cursor
 * backfill fingerprint). Same as normalizeFolderPath but WITHOUT realpathSync, so the result
 * depends only on the input string and never drifts when a folder is created/deleted/relinked
 * between cycles. Do NOT use for matching — use normalizeFolderPath (which resolves symlinks).
 */
export function lexicalFolderKey(input: string): string {
  let out = input.trim();
  if (out.length === 0) return '';
  if (out === '~') out = homedir();
  else if (out.startsWith('~/')) out = join(homedir(), out.slice(2));
  out = out.replace(/\/+$/, '');
  if (CASE_INSENSITIVE_FS) out = out.toLowerCase();
  return out;
}
