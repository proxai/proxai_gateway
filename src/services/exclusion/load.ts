// src/services/exclusion/load.ts
import { isAbsolute } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { statFile } from 'core/io/fs';
import type { MinimalLogger } from 'core/log';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the excluded-project list from the profile's config.toml `[capture] excluded_projects`.
 *
 * Runs EVERY poll cycle (so a CLI edit takes effect with no restart and un-exclude -> backfill
 * stays live) and must NEVER throw into the capture loop. FAIL-SAFE, not fail-open: if the file
 * cannot be read or parsed (missing, unreadable, malformed TOML) it returns `fallbackOnError`
 * (the daemon's last-known list) rather than [] — returning [] would transiently un-exclude every
 * project for that cycle and, for watermark-advancing sources, irreversibly capture the very data
 * the user asked to withhold. A SUCCESSFULLY parsed config with no/blank `excluded_projects`
 * legitimately yields [] (that is how "I cleared my exclusions" is expressed). Entries are trimmed;
 * an entry that is neither absolute nor ~-prefixed is skipped + logged.
 */
export async function loadExcludedProjects(
  configFilePath: string,
  fallbackOnError: readonly string[] = [],
  logger?: MinimalLogger,
): Promise<readonly string[]> {
  let raw: unknown;
  try {
    const stat = await statFile(configFilePath);
    if (!stat.exists) return fallbackOnError;
    raw = parseToml(await Bun.file(configFilePath).text());
  } catch {
    logger?.warn(
      { event: 'exclusion.config_read_failed', path: configFilePath },
      'could not read/parse config.toml for exclusions; keeping the last-known exclusion set this cycle',
    );
    return fallbackOnError;
  }
  const capture = isRecord(raw) ? raw['capture'] : undefined;
  const list = isRecord(capture) ? capture['excluded_projects'] : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const line = entry.trim();
    if (line.length === 0) continue;
    if (!isAbsolute(line) && !line.startsWith('~')) {
      logger?.warn(
        { event: 'exclusion.invalid_pattern', line },
        'skipping non-absolute exclusion pattern (must be an absolute or ~-prefixed path)',
      );
      continue;
    }
    out.push(line);
  }
  return out;
}
