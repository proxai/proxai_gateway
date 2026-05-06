import { collectCursorFile, defaultCursorUserRoot, discoverCursorFiles } from 'sources/cursor';
import { hasAnyCursor } from 'services/buffer';
import { SOURCE_NAME_CURSOR } from 'services/polling/polling.constants.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface CursorSourcePollerOptions {
  baseDir?: string;
  initialScanWindowDays?: number;
}

export function makeCursorSourcePoller(options: CursorSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultCursorUserRoot();
  const initialScanWindowDays = options.initialScanWindowDays;
  return (ctx) => pollCursor(ctx, baseDir, initialScanWindowDays);
}

async function pollCursor(
  ctx: SourcePollerContext,
  baseDir: string,
  initialScanWindowDays: number | undefined,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  const minimumMtime = resolveMinimumMtime(ctx, initialScanWindowDays);

  let files;
  try {
    files = await discoverCursorFiles(baseDir, { minimumMtime });
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

function resolveMinimumMtime(
  ctx: SourcePollerContext,
  initialScanWindowDays: number | undefined,
): Date | null {
  if (ctx.minimumMtimeOverride !== undefined) return ctx.minimumMtimeOverride;
  if (initialScanWindowDays === undefined || initialScanWindowDays <= 0) return null;
  if (hasAnyCursor(ctx.buffer, SOURCE_NAME_CURSOR)) return null;
  return new Date(Date.now() - initialScanWindowDays * 24 * 60 * 60 * 1000);
}
