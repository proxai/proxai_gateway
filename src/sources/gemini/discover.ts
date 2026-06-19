import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import { geminiConversationIdFromPath } from 'sources/gemini/agyhub.ts';
import {
  ANTIGRAVITY_IDE_PLATFORM,
  GEMINI_TRANSCRIPT_GLOB,
} from 'sources/gemini/gemini.constants.ts';
import type { DiscoveredGeminiFile } from 'sources/gemini/gemini.types.ts';

export interface DiscoverGeminiTranscriptsOptions {
  minimumMtime?: Date | null;
}

export async function discoverGeminiTranscripts(
  baseDir: string,
  options: DiscoverGeminiTranscriptsOptions = {},
): Promise<DiscoveredGeminiFile[]> {
  const found: DiscoveredGeminiFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  // dot:true REQUIRED — transcripts live under the hidden .system_generated/ segment.
  const glob = new Bun.Glob(GEMINI_TRANSCRIPT_GLOB);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true, dot: true })) {
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
      sourcePlatform: ANTIGRAVITY_IDE_PLATFORM,
      conversationId: geminiConversationIdFromPath(sourcePath),
    });
  }

  return found;
}
