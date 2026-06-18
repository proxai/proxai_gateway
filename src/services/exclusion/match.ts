// src/services/exclusion/match.ts
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

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
  try {
    out = realpathSync(out);
  } catch {
    // path may not exist (yet) or be inaccessible; fall back to lexical normalization
  }
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
