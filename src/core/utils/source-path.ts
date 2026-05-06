/**
 * Source-path generation suffix helpers.
 *
 * When the gateway detects that a SQLite source DB was vacuum'd (rowid space
 * rotated), we must re-key the source so the server treats it as a fresh
 * stream. Per planning/nest-contract.md §6.3, the canonical pattern is a
 * `#gen=N` suffix appended to `source_path`:
 *
 *     /path/to/state.vscdb           -> generation 0 (no suffix)
 *     /path/to/state.vscdb#gen=1     -> generation 1
 *     /path/to/state.vscdb#gen=2     -> generation 2
 *
 * The suffix is part of `source_path` — `source_path_hash` is recomputed from
 * the new full string by the existing hash helper, producing a fresh
 * `(host_id, source_path_hash)` scope. The old cursor row stays in the local
 * buffer as a frozen historical record; its corresponding server-side stream
 * is closed.
 */

const GEN_SUFFIX_RE = /#gen=(\d+)$/;

/**
 * Returns the generation number encoded in the path's `#gen=N` suffix, or 0
 * if no suffix is present. A non-numeric or otherwise-malformed `#gen=` tail
 * is treated as 0 (the suffix does not match).
 */
export function currentGenerationNumber(path: string): number {
  const match = path.match(GEN_SUFFIX_RE);
  if (match === null) return 0;
  const parsed = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Returns the same path with its generation suffix stripped, if present.
 */
export function stripGenerationSuffix(path: string): string {
  return path.replace(GEN_SUFFIX_RE, '');
}

/**
 * Returns a new path string with the generation suffix incremented by one.
 *
 *     "/path/file.db"           -> "/path/file.db#gen=1"
 *     "/path/file.db#gen=1"     -> "/path/file.db#gen=2"
 *     "/path/file.db#gen=99"    -> "/path/file.db#gen=100"
 */
export function nextGenerationSuffix(currentPath: string): string {
  const base = stripGenerationSuffix(currentPath);
  const next = currentGenerationNumber(currentPath) + 1;
  return `${base}#gen=${next}`;
}
