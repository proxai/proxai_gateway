import { basename, join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import { geminiConversationIdFromPath } from 'sources/gemini/agyhub.ts';
import {
  ANTIGRAVITY_IDE_PLATFORM,
  GEMINI_CONVERSATIONS_DB_GLOB,
  GEMINI_TRANSCRIPT_GLOB,
} from 'sources/gemini/gemini.constants.ts';
import type { DiscoveredGeminiDbFile, DiscoveredGeminiFile } from 'sources/gemini/gemini.types.ts';

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

/**
 * Discover `conversations/<uuid>.db` files paired with an existing `transcript.jsonl`.
 * The token capture reads the `.db` but is stamped with the transcript's source_path
 * (so it shares the content chat's chat_id). A `.db` with no paired transcript is
 * skipped — the token capture must land on an existing content chat, and the
 * per-conversation exclusion gate keys on the conversationId.
 */
export async function discoverGeminiConversationDbs(
  baseDir: string,
  options: DiscoverGeminiTranscriptsOptions = {},
): Promise<DiscoveredGeminiDbFile[]> {
  const found: DiscoveredGeminiDbFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(GEMINI_CONVERSATIONS_DB_GLOB);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const dbPath = join(baseDir, relativePath);
    const dbStat = await statFile(dbPath);
    if (!dbStat.exists) continue;
    if (minMtimeMs !== null && dbStat.mtimeMs < minMtimeMs) continue;

    const conversationId = basename(relativePath, '.db');
    if (conversationId.length === 0) continue;

    // Build the transcript path IDENTICALLY to the content discovery above
    // (join(baseDir, 'brain/<uuid>/.system_generated/logs/transcript.jsonl')) so the
    // hash matches the content chat_id byte-for-byte on every OS.
    const transcriptSourcePath = join(
      baseDir,
      `brain/${conversationId}/.system_generated/logs/transcript.jsonl`,
    );
    const transcriptStat = await statFile(transcriptSourcePath);
    if (!transcriptStat.exists) continue;

    // Defensive: the exclusion gate keys on the id derivable from the transcript
    // path; a malformed .db filename that doesn't round-trip is skipped.
    if (geminiConversationIdFromPath(transcriptSourcePath) !== conversationId) continue;

    found.push({
      dbPath,
      transcriptSourcePath,
      transcriptSourcePathHash: sha256Hex(transcriptSourcePath),
      conversationId,
      dbSizeBytes: dbStat.size,
      dbInode: Number(dbStat.inode),
      sourcePlatform: ANTIGRAVITY_IDE_PLATFORM,
    });
  }

  return found;
}
