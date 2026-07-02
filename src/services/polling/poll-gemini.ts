import {
  collectGeminiConversation,
  collectGeminiGenMetadata,
  defaultGeminiAntigravityBaseDir,
  discoverGeminiConversationDbs,
  discoverGeminiTranscripts,
  type DiscoveredGeminiDbFile,
  type DiscoveredGeminiFile,
  type GeminiCollectorContext,
} from 'sources/gemini';
import { loadAgyhubFolderMap } from 'sources/gemini/agyhub.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

/** Injectable token-pass collaborators (mirrors CodexSourceDeps) so the
 *  gen_metadata discovery/collect paths are testable in isolation. */
export interface GeminiSourceDeps {
  discoverGeminiConversationDbs: typeof discoverGeminiConversationDbs;
  collectGeminiGenMetadata: typeof collectGeminiGenMetadata;
}

export interface GeminiSourcePollerOptions {
  baseDir?: string;
  deps?: Partial<GeminiSourceDeps>;
}

export function makeGeminiSourcePoller(options: GeminiSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultGeminiAntigravityBaseDir();
  const deps: GeminiSourceDeps = {
    discoverGeminiConversationDbs:
      options.deps?.discoverGeminiConversationDbs ?? discoverGeminiConversationDbs,
    collectGeminiGenMetadata: options.deps?.collectGeminiGenMetadata ?? collectGeminiGenMetadata,
  };
  return (ctx) => pollGemini(ctx, baseDir, deps);
}

async function pollGemini(
  ctx: SourcePollerContext,
  baseDir: string,
  deps: GeminiSourceDeps,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  const minimumMtime = ctx.minimumMtimeOverride !== undefined ? ctx.minimumMtimeOverride : null;

  let files: DiscoveredGeminiFile[];
  try {
    files = await discoverGeminiTranscripts(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  const collectorContext: GeminiCollectorContext = {
    buffer: ctx.buffer,
    gatewayVersion: ctx.gatewayVersion,
    maxDecompressedBytes: ctx.maxDecompressedBytes,
  };
  if (ctx.logger !== undefined) collectorContext.logger = ctx.logger;
  if (ctx.excludedProjects !== undefined) collectorContext.excludedProjects = ctx.excludedProjects;

  // Only read/decode the agyhub index (up to 8MB) when there is at least one exclusion to
  // enforce; otherwise the folder map is never consulted, so skip the work and pass an empty
  // fail-open map. Decoding when nothing is excluded would burn CPU for no behavioral effect.
  if (ctx.excludedProjects && ctx.excludedProjects.length > 0) {
    const agy = loadAgyhubFolderMap(baseDir);
    collectorContext.agyhubFolders = agy.folders;
    collectorContext.agyhubComplete = agy.complete;
  } else {
    collectorContext.agyhubFolders = new Map();
    collectorContext.agyhubComplete = true;
  }

  async function processNext(index: number): Promise<void> {
    const file = files[index];
    if (file === undefined) return;
    const collectResult = await collectGeminiConversation(file, collectorContext);
    result.filesProcessed += 1;
    result.capturedBatches += collectResult.capturedBatches;
    result.capturedBytes += collectResult.capturedBytes;
    for (const err of collectResult.errors) {
      result.errors.push({ sourcePath: err.sourcePath, reason: err.reason });
    }
    await processNext(index + 1);
  }

  await processNext(0);

  // Token pass: content-free `gen_metadata` capture from conversations/<uuid>.db,
  // stamped with the transcript's source_path (same chat). Uses the SAME collector
  // context (agyhub folders + exclusions), so the exclusion PAUSE gate is enforced.
  let dbFiles: DiscoveredGeminiDbFile[];
  try {
    dbFiles = await deps.discoverGeminiConversationDbs(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const dbFile of dbFiles) {
    const tokenResult = await deps.collectGeminiGenMetadata(dbFile, collectorContext);
    result.filesProcessed += 1;
    result.capturedBatches += tokenResult.capturedBatches;
    result.capturedBytes += tokenResult.capturedBytes;
    for (const err of tokenResult.errors) {
      result.errors.push({ sourcePath: err.sourcePath, reason: err.reason });
    }
  }

  return result;
}
