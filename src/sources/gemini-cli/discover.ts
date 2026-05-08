import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  GEMINI_CLI_GLOB_PATTERN,
  GEMINI_CLI_TMP_SUBPATH,
} from 'sources/gemini-cli/gemini-cli.constants.ts';
import type { DiscoveredGeminiCliFile } from 'sources/gemini-cli/gemini-cli.types.ts';

export function defaultGeminiCliTmpRoot(): string {
  return join(homedir(), GEMINI_CLI_TMP_SUBPATH);
}

export interface DiscoverGeminiCliOptions {
  minimumMtime?: Date | null;
}

export async function discoverGeminiCliFiles(
  baseDir: string = defaultGeminiCliTmpRoot(),
  options: DiscoverGeminiCliOptions = {},
): Promise<DiscoveredGeminiCliFile[]> {
  const found: DiscoveredGeminiCliFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  if (!(await Bun.file(baseDir).exists())) {
    const stat = await statFile(baseDir);
    if (!stat.exists) return found;
  }

  const glob = new Bun.Glob(GEMINI_CLI_GLOB_PATTERN);

  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    const stat = await statFile(sourcePath);
    if (!stat.exists) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;

    found.push({
      sourcePath,
      sourcePathHash: sha256Hex(sourcePath),
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: stat.mtimeMs,
    });
  }

  return found;
}
