import {
  collectClaudeCodeFile,
  defaultClaudeCodeProjectsRoot,
  discoverClaudeCodeFiles,
} from 'sources/claude-code';
import { hasAnyCursor } from 'services/buffer';
import { SOURCE_NAME_CLAUDE_CODE } from 'services/polling/polling.constants.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface ClaudeCodeSourcePollerOptions {
  baseDir?: string;
  initialScanWindowDays?: number;
}

export function makeClaudeCodeSourcePoller(
  options: ClaudeCodeSourcePollerOptions = {},
): SourcePoller {
  const baseDir = options.baseDir ?? defaultClaudeCodeProjectsRoot();
  const initialScanWindowDays = options.initialScanWindowDays;
  return (ctx) => pollClaudeCode(ctx, baseDir, initialScanWindowDays);
}

async function pollClaudeCode(
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
    files = await discoverClaudeCodeFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const file of files) {
    const collectResult = await collectClaudeCodeFile(file, ctx);
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
  if (hasAnyCursor(ctx.buffer, SOURCE_NAME_CLAUDE_CODE)) return null;
  return new Date(Date.now() - initialScanWindowDays * 24 * 60 * 60 * 1000);
}
