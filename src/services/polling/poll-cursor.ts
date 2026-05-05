import { collectCursorFile, defaultCursorUserRoot, discoverCursorFiles } from 'sources/cursor';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface CursorSourcePollerOptions {
  baseDir?: string;
}

export function makeCursorSourcePoller(options: CursorSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultCursorUserRoot();
  return (ctx) => pollCursor(ctx, baseDir);
}

async function pollCursor(ctx: SourcePollerContext, baseDir: string): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let files;
  try {
    files = await discoverCursorFiles(baseDir);
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const file of files) {
    const collectResult = await collectCursorFile(file, ctx);
    result.filesProcessed++;
    result.capturedBatches += collectResult.capturedBatches;
    result.capturedBytes += collectResult.capturedBytes;
    for (const err of collectResult.errors) {
      result.errors.push({ sourcePath: err.sourcePath, reason: err.reason });
    }
  }

  return result;
}
