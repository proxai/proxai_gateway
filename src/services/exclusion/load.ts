// src/services/exclusion/load.ts
import { isAbsolute, join } from 'node:path';
import { statFile } from 'core/io/fs';
import type { MinimalLogger } from 'core/log';

export const EXCLUDED_PROJECTS_FILE_NAME = 'excluded-projects';

/**
 * Read the local gitignore-style exclusion file from `<configDir>/excluded-projects`.
 * Keeps only absolute (or ~-prefixed) paths; relative/invalid lines are skipped and
 * logged (never silently treated as never-matching literals). Missing file -> [].
 */
export async function loadExcludedProjects(
  configDir: string,
  logger?: MinimalLogger,
): Promise<readonly string[]> {
  const path = join(configDir, EXCLUDED_PROJECTS_FILE_NAME);
  const stat = await statFile(path);
  if (!stat.exists) return [];

  const text = await Bun.file(path).text();
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // Accept any absolute path (POSIX `/…`, Windows `C:\…` / `\…`) or a
    // ~-prefixed home path. `isAbsolute` is host-native, so a Windows drive
    // path is kept on Windows and a POSIX path on POSIX; relative lines are
    // skipped + logged (never silently kept as a never-matching literal).
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
