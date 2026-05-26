import { existsSync } from 'node:fs';
import { devModeSentinelPath } from 'core/io/fs';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { formatBytes } from 'core/utils';

const DAEMON_INFER_FROM_DRAIN_MS = 90_000;
const DAEMON_INFER_FROM_CAPTURE_MS = 360_000;

export function inferDaemonAlive(
  drainLastCycleAt: string | null,
  captureLastCycleAt: string | null,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  if (drainLastCycleAt !== null) {
    const t = Date.parse(drainLastCycleAt);
    if (Number.isFinite(t) && nowMs - t < DAEMON_INFER_FROM_DRAIN_MS) return true;
  }
  if (captureLastCycleAt !== null) {
    const t = Date.parse(captureLastCycleAt);
    if (Number.isFinite(t) && nowMs - t < DAEMON_INFER_FROM_CAPTURE_MS) return true;
  }
  return false;
}

import { buildEmptyStatusJson, buildStatusJson } from 'cli/commands/status/build-json.ts';
import { gatherStatusSnapshot } from 'cli/commands/status/gather-snapshot.ts';
import { renderBasic } from 'cli/commands/status/render/render-basic.ts';
import { renderVerbose } from 'cli/commands/status/render/render-verbose.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusCommandDeps, StatusCommandOptions } from 'cli/commands/status/status.types.ts';
import { deriveUnifiedSummary } from 'cli/commands/status/unified-summary.ts';
import { startWatchLoop } from 'cli/commands/status/watch-loop.ts';

export type {
  StatusCommandDeps,
  StatusCommandOptions,
  StatusJsonOutput,
  StatusSnapshot,
} from 'cli/commands/status/status.types.ts';
export { formatBytes };
export { readShippedBySource } from 'cli/commands/status/gather-snapshot.ts';
export { deriveUnifiedSummary } from 'cli/commands/status/unified-summary.ts';
export type {
  UnifiedStatusLevel,
  UnifiedStatusSummary,
} from 'cli/commands/status/unified-summary.types.ts';

export async function runStatus(
  deps: StatusCommandDeps,
  options: StatusCommandOptions = {},
): Promise<CommandResult> {
  if (options.json === true) {
    return runJsonStatus(deps);
  }
  return runWatchStatus(deps, options);
}

async function runJsonStatus(deps: StatusCommandDeps): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    const isDevMode = existsSync(deps.devModeSentinelPath ?? devModeSentinelPath());
    const emptyJson = buildEmptyStatusJson();
    emptyJson.isDevMode = isDevMode;
    deps.output.info(JSON.stringify(emptyJson));
    return { exitCode: EXIT_CODE.notInstalled };
  }
  if (deps.buffer === undefined) {
    deps.output.error('buffer database is unavailable');
    return { exitCode: EXIT_CODE.error };
  }
  const snapshot = await gatherStatusSnapshot(deps, deps.buffer);
  deps.output.info(JSON.stringify(buildStatusJson(snapshot)));
  return { exitCode: EXIT_CODE.ok };
}

async function runWatchStatus(
  deps: StatusCommandDeps,
  options: StatusCommandOptions,
): Promise<CommandResult> {
  const stdin = options.stdin ?? process.stdin;
  const verbose = options.verbose === true;
  const render = verbose ? renderVerbose : renderBasic;

  const handle = startWatchLoop({
    output: deps.output,
    stdin,
    render,
    gatherFrame: () => buildFrame(deps),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.clearScreen !== undefined ? { clearScreen: options.clearScreen } : {}),
  });
  await handle.wait();
  return { exitCode: EXIT_CODE.ok };
}

async function buildFrame(deps: StatusCommandDeps): Promise<RenderInputs> {
  const exists = await deps.configExists();
  const isDevMode = existsSync(deps.devModeSentinelPath ?? devModeSentinelPath());
  const nowLocal = (deps.now ?? ((): Date => new Date()))();
  const version = deps.currentVersion ?? null;

  if (!exists) {
    return {
      summary: deriveUnifiedSummary({
        configured: false,
        daemonRunning: false,
        daemonInferredAlive: false,
        daemonLastCycleAt: null,
        authFailed: false,
        paused: false,
        pausedReason: '',
        bufferFull: false,
        bufferFullPendingBytes: null,
        bufferFullThreshold: null,
        sessionStopped: false,
      }),
      snapshot: null,
      notConfigured: true,
      isDevMode,
      nowLocal,
      version,
    };
  }

  if (deps.buffer === undefined) {
    return {
      summary: deriveUnifiedSummary({
        configured: true,
        daemonRunning: false,
        daemonInferredAlive: false,
        daemonLastCycleAt: null,
        authFailed: false,
        paused: false,
        pausedReason: '',
        bufferFull: false,
        bufferFullPendingBytes: null,
        bufferFullThreshold: null,
        sessionStopped: false,
      }),
      snapshot: null,
      notConfigured: false,
      isDevMode,
      nowLocal,
      version,
    };
  }

  const snapshot = await gatherStatusSnapshot(deps, deps.buffer);
  const daemonInferredAlive = inferDaemonAlive(
    snapshot.drainLastCycleAt,
    snapshot.captureLastCycleAt,
    snapshot.now,
  );
  const summary = deriveUnifiedSummary({
    configured: true,
    daemonRunning: snapshot.runtime.isRunning,
    daemonInferredAlive,
    daemonLastCycleAt: snapshot.drainLastCycleAt ?? snapshot.captureLastCycleAt,
    authFailed: snapshot.authFailed,
    paused: snapshot.paused,
    pausedReason: snapshot.pausedReason,
    bufferFull: snapshot.bufferFull,
    bufferFullPendingBytes: snapshot.bufferFullPendingBytes,
    bufferFullThreshold: snapshot.bufferFullThreshold,
    sessionStopped: snapshot.sessionStopped,
  });
  return {
    summary,
    snapshot,
    notConfigured: false,
    isDevMode,
    nowLocal,
    version,
  };
}
