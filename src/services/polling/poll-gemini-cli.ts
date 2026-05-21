import {
  collectGeminiCliFile,
  defaultGeminiCliTmpRoot,
  discoverGeminiCliFiles,
} from 'sources/gemini-cli';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface GeminiCliSourcePollerOptions {
  baseDir?: string;
}

export function makeGeminiCliSourcePoller(
  options: GeminiCliSourcePollerOptions = {},
): SourcePoller {
  const baseDir = options.baseDir ?? defaultGeminiCliTmpRoot();
  return (ctx) => pollGeminiCli(ctx, baseDir);
}

async function pollGeminiCli(
  ctx: SourcePollerContext,
  baseDir: string,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  const minimumMtime = resolveMinimumMtime(ctx);

  let files;
  try {
    files = await discoverGeminiCliFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const file of files) {
    const collectResult = await collectGeminiCliFile(file, ctx);
    result.filesProcessed++;
    result.capturedBatches += collectResult.capturedBatches;
    result.capturedBytes += collectResult.capturedBytes;
    for (const err of collectResult.errors) {
      result.errors.push({ sourcePath: err.sourcePath, reason: err.reason });
    }
  }

  return result;
}

function resolveMinimumMtime(ctx: SourcePollerContext): Date | null {
  if (ctx.minimumMtimeOverride !== undefined) return ctx.minimumMtimeOverride;
  return null;
}
