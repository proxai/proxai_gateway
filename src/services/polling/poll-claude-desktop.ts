import {
  collectClaudeDesktopFile,
  defaultClaudeDesktopSessionsRoot,
  discoverClaudeDesktopFiles,
  type ClaudeDesktopCollectorContext,
  type DiscoveredClaudeDesktopFile,
} from 'sources/claude-desktop';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface ClaudeDesktopSourcePollerOptions {
  baseDir?: string;
}

export function makeClaudeDesktopSourcePoller(
  options: ClaudeDesktopSourcePollerOptions = {},
): SourcePoller {
  const baseDir = options.baseDir ?? defaultClaudeDesktopSessionsRoot();
  return (ctx) => pollClaudeDesktop(ctx, baseDir);
}

async function pollClaudeDesktop(
  ctx: SourcePollerContext,
  baseDir: string,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  const minimumMtime = ctx.minimumMtimeOverride !== undefined ? ctx.minimumMtimeOverride : null;

  let files: DiscoveredClaudeDesktopFile[];
  try {
    files = await discoverClaudeDesktopFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  let filesProcessed = 0;
  let capturedBatches = 0;
  let capturedBytes = 0;

  async function processNext(index: number): Promise<void> {
    const file = files[index];
    if (file === undefined) return;
    const collectResult = await collectClaudeDesktopFile(
      file,
      // Bridge incompatible Logger types via a single commented as unknown cast
      ctx as unknown as ClaudeDesktopCollectorContext,
    );
    filesProcessed++;
    capturedBatches += collectResult.capturedBatches;
    capturedBytes += collectResult.capturedBytes;
    for (const err of collectResult.errors) {
      result.errors.push({ sourcePath: err.sourcePath, reason: err.reason });
    }
    await processNext(index + 1);
  }

  await processNext(0);

  result.filesProcessed = filesProcessed;
  result.capturedBatches = capturedBatches;
  result.capturedBytes = capturedBytes;

  return result;
}
