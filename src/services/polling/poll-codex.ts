import {
  collectCodexRollout,
  collectCodexState,
  defaultCodexHome,
  discoverCodexRolloutFiles,
  discoverCodexStateSqlite,
} from 'sources/codex';
import { CODEX_DEFAULT_AGENT_SCHEMA_VERSION } from 'sources/codex/codex.constants.ts';
import { hasAnyCursor } from 'services/buffer';
import { SOURCE_NAME_CODEX } from 'services/polling/polling.constants.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerError,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface CodexSourcePollerOptions {
  baseDir?: string;
  initialScanWindowDays?: number;
}

export function makeCodexSourcePoller(options: CodexSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultCodexHome();
  const initialScanWindowDays = options.initialScanWindowDays;
  return (ctx) => pollCodex(ctx, baseDir, initialScanWindowDays);
}

async function pollCodex(
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

  let agentSchemaVersion = CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  const minimumMtime = resolveMinimumMtime(ctx, initialScanWindowDays);

  try {
    const stateFile = await discoverCodexStateSqlite(baseDir, { minimumMtime });
    if (stateFile !== null) {
      const stateOutcome = await collectCodexState(stateFile, ctx);
      agentSchemaVersion = stateOutcome.agentSchemaVersion;
      result.filesProcessed++;
      result.capturedBatches += stateOutcome.result.capturedBatches;
      result.capturedBytes += stateOutcome.result.capturedBytes;
      for (const err of stateOutcome.result.errors) {
        const entry: SourcePollerError = { sourcePath: err.sourcePath, reason: err.reason };
        if (err.table !== undefined) entry.table = err.table;
        result.errors.push(entry);
      }
    }
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  let rolloutFiles;
  try {
    rolloutFiles = await discoverCodexRolloutFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const file of rolloutFiles) {
    const collectResult = await collectCodexRollout(file, ctx, agentSchemaVersion);
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
  if (hasAnyCursor(ctx.buffer, SOURCE_NAME_CODEX)) return null;
  return new Date(Date.now() - initialScanWindowDays * 24 * 60 * 60 * 1000);
}
