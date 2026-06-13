import {
  collectGeminiConversation,
  defaultGeminiCliConversationsDir,
  defaultGeminiIdeConversationsDir,
  discoverGeminiConversations,
  geminiPlatformForRoot,
  type DiscoveredGeminiFile,
  type GeminiCollectorContext,
} from 'sources/gemini';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface GeminiSourcePollerOptions {
  cliBaseDir?: string;
  ideBaseDir?: string;
}

export function makeGeminiSourcePoller(options: GeminiSourcePollerOptions = {}): SourcePoller {
  const cliBaseDir = options.cliBaseDir ?? defaultGeminiCliConversationsDir();
  const ideBaseDir = options.ideBaseDir ?? defaultGeminiIdeConversationsDir();
  return (ctx) => pollGemini(ctx, cliBaseDir, ideBaseDir);
}

async function pollGemini(
  ctx: SourcePollerContext,
  cliBaseDir: string,
  ideBaseDir: string,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  const minimumMtime = ctx.minimumMtimeOverride !== undefined ? ctx.minimumMtimeOverride : null;

  const cliFiles = await discoverRoot(cliBaseDir, 'cli', minimumMtime, result);
  const ideFiles = await discoverRoot(ideBaseDir, 'ide', minimumMtime, result);
  const files = [...cliFiles, ...ideFiles];

  const collectorContext: GeminiCollectorContext = {
    buffer: ctx.buffer,
    gatewayVersion: ctx.gatewayVersion,
    maxDecompressedBytes: ctx.maxDecompressedBytes,
    ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
  };

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

async function discoverRoot(
  baseDir: string,
  rootKind: 'cli' | 'ide',
  minimumMtime: Date | null,
  result: SourcePollerResult,
): Promise<DiscoveredGeminiFile[]> {
  try {
    return await discoverGeminiConversations(baseDir, {
      minimumMtime,
      sourcePlatform: geminiPlatformForRoot(rootKind),
    });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
