import { collectCodexRollout, defaultCodexHome, discoverCodexRolloutFiles } from 'sources/codex';
import { CODEX_DEFAULT_AGENT_SCHEMA_VERSION } from 'sources/codex/codex.constants.ts';
import type { CodexCollectorContext } from 'sources/codex/codex.types.ts';
import type {
  SourcePoller,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';

export interface CodexSourceDeps {
  discoverCodexRolloutFiles: typeof discoverCodexRolloutFiles;
  collectCodexRollout: typeof collectCodexRollout;
}

export interface CodexSourcePollerOptions {
  baseDir?: string;
  deps?: Partial<CodexSourceDeps>;
}

export function makeCodexSourcePoller(options: CodexSourcePollerOptions = {}): SourcePoller {
  const baseDir = options.baseDir ?? defaultCodexHome();
  const deps: CodexSourceDeps = {
    discoverCodexRolloutFiles: options.deps?.discoverCodexRolloutFiles ?? discoverCodexRolloutFiles,
    collectCodexRollout: options.deps?.collectCodexRollout ?? collectCodexRollout,
  };
  return (ctx) => pollCodex(ctx, baseDir, deps);
}

async function pollCodex(
  ctx: SourcePollerContext,
  baseDir: string,
  deps: CodexSourceDeps,
): Promise<SourcePollerResult> {
  const result: SourcePollerResult = {
    filesProcessed: 0,
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  // State capture intentionally disabled: nest never parses state sqlite into
  // agent-call-records, and capturing it unfiltered would upload excluded projects' rows.
  // discoverCodexStateSqlite / collectCodexState stay exported from sources/codex (with their
  // own unit tests) but are no longer wired into this poller.
  const agentSchemaVersion = CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  const minimumMtime = resolveMinimumMtime(ctx);

  let rolloutFiles;
  try {
    rolloutFiles = await deps.discoverCodexRolloutFiles(baseDir, { minimumMtime });
  } catch (err) {
    result.errors.push({
      sourcePath: baseDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  const collectorCtx: CodexCollectorContext = {
    buffer: ctx.buffer,
    gatewayVersion: ctx.gatewayVersion,
    maxDecompressedBytes: ctx.maxDecompressedBytes,
  };
  if (ctx.logger !== undefined) collectorCtx.logger = ctx.logger;
  if (ctx.excludedProjects !== undefined) {
    collectorCtx.excludedProjects = ctx.excludedProjects;
  }

  for (const file of rolloutFiles) {
    const collectResult = await deps.collectCodexRollout(file, collectorCtx, agentSchemaVersion);
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
