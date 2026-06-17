import {
  collectClaudeCodeFile,
  defaultClaudeCodeProjectsRoot,
  discoverClaudeCodeFiles,
} from 'sources/claude-code';
import type { ClaudeCodeCollectorContext } from 'sources/claude-code';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface ClaudeCodeSourcePollerOptions {
  baseDir?: string;
  desktopCliSessionIds?: ReadonlySet<string>;
}

export function makeClaudeCodeSourcePoller(
  options: ClaudeCodeSourcePollerOptions = {},
): SourcePoller {
  const baseDir = options.baseDir ?? defaultClaudeCodeProjectsRoot();
  const desktopCliSessionIds = options.desktopCliSessionIds;
  return (ctx) => pollClaudeCode(ctx, baseDir, desktopCliSessionIds);
}

async function pollClaudeCode(
  ctx: SourcePollerContext,
  baseDir: string,
  desktopCliSessionIds: ReadonlySet<string> | undefined,
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
    files = await discoverClaudeCodeFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  const collectorCtx: ClaudeCodeCollectorContext = {
    buffer: ctx.buffer,
    gatewayVersion: ctx.gatewayVersion,
    maxDecompressedBytes: ctx.maxDecompressedBytes,
  };
  if (ctx.logger !== undefined) collectorCtx.logger = ctx.logger;
  if (desktopCliSessionIds !== undefined) {
    collectorCtx.desktopCliSessionIds = desktopCliSessionIds;
  }
  if (ctx.excludedProjects !== undefined) {
    collectorCtx.excludedProjects = ctx.excludedProjects;
  }

  for (const file of files) {
    const collectResult = await collectClaudeCodeFile(file, collectorCtx);
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
