// src/services/exclusion/match.ts
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

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
 * trim -> empty/whitespace => '' -> expand leading ~ -> reject non-absolute (=> '') ->
 * resolve symlinks (deepest existing ancestor) -> strip trailing slashes -> case-fold.
 * Never throws. Returns '' for any input that cannot be a real absolute folder.
 */
export function normalizeFolderPath(input: string): string {
  let out = input.trim();
  // Empty/whitespace input must NOT fall through to realpathSync(''), which resolves to the
  // daemon's process.cwd() — that would silently turn a junk cwd into "wherever the daemon runs".
  if (out.length === 0) return '';
  if (out === '~') out = homedir();
  else if (out.startsWith('~/')) out = join(homedir(), out.slice(2));
  // A non-absolute path here would be resolved against the daemon's cwd by realpathSync — never
  // anchor a chat's folder identity to "wherever the daemon runs". Treat it as no-match.
  if (!isAbsolute(out)) return '';
  out = realpathOfDeepestExisting(out);
  // Canonicalize Windows '\' to '/' so the boundary-anchored prefix check in
  // isFolderUnderPrefixes (`startsWith(prefix + '/')`) and the trailing-slash
  // strip below both operate on a single separator on every OS.
  out = out.replace(/\\/g, '/');
  out = out.replace(/\/+$/, '');
  if (CASE_INSENSITIVE_FS) out = out.toLowerCase();
  return out;
}

/**
 * Normalize an exclusion list once into a comparable prefix list (drops blanks + anything that
 * canonicalizes to '' — empty/whitespace/non-absolute). Hoist this out of per-item loops so the
 * realpathSync cost is paid once per cycle, not once per candidate folder.
 */
export function normalizeExcludedPrefixes(excludedPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of excludedPaths) {
    const prefix = normalizeFolderPath(raw);
    if (prefix.length > 0) out.push(prefix);
  }
  return out;
}

/** True if `folderPath` equals, or is nested under, any ALREADY-NORMALIZED prefix (boundary anchored). */
export function isFolderUnderPrefixes(
  folderPath: string,
  normalizedPrefixes: readonly string[],
): boolean {
  if (normalizedPrefixes.length === 0) return false;
  const folder = normalizeFolderPath(folderPath);
  if (folder.length === 0) return false;
  for (const prefix of normalizedPrefixes) {
    if (folder === prefix || folder.startsWith(prefix + '/')) return true;
  }
  return false;
}

/** True if `folderPath` equals, or is nested under, any excluded path (path-boundary anchored). */
export function isProjectExcluded(folderPath: string, excludedPaths: readonly string[]): boolean {
  return isFolderUnderPrefixes(folderPath, normalizeExcludedPrefixes(excludedPaths));
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
  if (!isAbsolute(out)) return '';
  out = out.replace(/\\/g, '/'); // Windows '\' -> '/' (same canonical form as normalizeFolderPath)
  out = out.replace(/\/+$/, '');
  if (CASE_INSENSITIVE_FS) out = out.toLowerCase();
  return out;
}
