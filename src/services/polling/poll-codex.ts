import {
  collectCodexRollout,
  collectCodexState,
  defaultCodexHome,
  discoverCodexRolloutFiles,
  discoverCodexStateSqlite,
} from 'sources/codex';
import { CODEX_DEFAULT_AGENT_SCHEMA_VERSION } from 'sources/codex/codex.constants.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerError,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface CodexSourcePollerOptions {
  baseDir?: string;
}

export function makeCodexSourcePoller(options: CodexSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultCodexHome();
  return (ctx) => pollCodex(ctx, baseDir);
}

async function pollCodex(ctx: SourcePollerContext, baseDir: string): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let agentSchemaVersion = CODEX_DEFAULT_AGENT_SCHEMA_VERSION;

  try {
    const stateFile = await discoverCodexStateSqlite(baseDir);
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
    rolloutFiles = await discoverCodexRolloutFiles(baseDir);
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
