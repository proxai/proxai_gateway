import {
  collectGeminiConversation,
  defaultGeminiAntigravityBaseDir,
  discoverGeminiTranscripts,
  type DiscoveredGeminiFile,
  type GeminiCollectorContext,
} from 'sources/gemini';
import { loadAgyhubFolderMap } from 'sources/gemini/agyhub.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface GeminiSourcePollerOptions {
  baseDir?: string;
}

export function makeGeminiSourcePoller(options: GeminiSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultGeminiAntigravityBaseDir();
  return (ctx) => pollGemini(ctx, baseDir);
}

async function pollGemini(ctx: SourcePollerContext, baseDir: string): Promise<SourcePollerResult> {
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
    agyhubFolders: loadAgyhubFolderMap(baseDir),
  };
  if (ctx.logger !== undefined) collectorContext.logger = ctx.logger;
  if (ctx.excludedProjects !== undefined) collectorContext.excludedProjects = ctx.excludedProjects;

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

  return result;
}
