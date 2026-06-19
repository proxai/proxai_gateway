import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import type { SourcePlatform } from 'services/contract';
import { geminiConversationIdFromPath } from 'sources/gemini/agyhub.ts';
import {
  ANTIGRAVITY_IDE_PLATFORM,
  GEMINI_CONVERSATIONS_GLOB,
  GEMINI_TRANSCRIPT_GLOB,
} from 'sources/gemini/gemini.constants.ts';
import type { DiscoveredGeminiFile } from 'sources/gemini/gemini.types.ts';

export interface DiscoverGeminiOptions {
  minimumMtime?: Date | null;
  sourcePlatform: SourcePlatform;
}

export async function discoverGeminiConversations(
  baseDir: string,
  options: DiscoverGeminiOptions,
): Promise<DiscoveredGeminiFile[]> {
  const found: DiscoveredGeminiFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(GEMINI_CONVERSATIONS_GLOB);
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
      sourcePlatform: options.sourcePlatform,
      conversationId: '',
    });
  }

  return found;
}

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
