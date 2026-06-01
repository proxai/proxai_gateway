import { join } from 'node:path';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { readBootId } from 'core/system/boot-id.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { formatBytes } from 'core/utils';

export { inferDaemonAlive } from 'cli/commands/status/daemon-liveness.ts';
import { inferDaemonAlive } from 'cli/commands/status/daemon-liveness.ts';
import { isLocalBuildPath } from 'cli/commands/status/local-build.ts';

import {
  buildEmptyStatusJson,
  buildStatusJson,
  localizeStatusJsonTimes,
} from 'cli/commands/status/build-json.ts';
import { gatherStatusSnapshot } from 'cli/commands/status/gather-snapshot.ts';
import { renderFullStatus } from 'cli/commands/status/render/render-full.ts';
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
    return runJsonStatus(deps, options.profileName ?? 'prod');
  }
  return runWatchStatus(deps, options);
}

async function runJsonStatus(
  deps: StatusCommandDeps,
  profileName: ProfileName,
): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    const isDevMode = await readDevModeSentinel(
      deps.devModeSentinelPath ?? join(profileRootDir(), 'DEV_MODE'),
      deps.readBootId ?? readBootId,
    );
    const emptyJson = buildEmptyStatusJson();
    emptyJson.isDevMode = isDevMode;
    deps.output.info(JSON.stringify(localizeStatusJsonTimes(emptyJson)));
    return { exitCode: EXIT_CODE.notInstalled };
  }
  if (deps.buffer === undefined) {
    deps.output.error('buffer database is unavailable');
    return { exitCode: EXIT_CODE.error };
  }
  const snapshot = await gatherStatusSnapshot(deps, deps.buffer, profileName);
  deps.output.info(JSON.stringify(localizeStatusJsonTimes(buildStatusJson(snapshot))));
  return { exitCode: EXIT_CODE.ok };
}

async function runWatchStatus(
  deps: StatusCommandDeps,
  options: StatusCommandOptions,
): Promise<CommandResult> {
  const stdin = options.stdin ?? process.stdin;
  const render = (inputs: RenderInputs): string => renderFullStatus(inputs, deps);

  const handle = startWatchLoop({
    output: deps.output,
    stdin,
    render,
    gatherFrame: () => buildDualFrame(deps, options),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.clearScreen !== undefined ? { clearScreen: options.clearScreen } : {}),
  });
  await handle.wait();
  return { exitCode: EXIT_CODE.ok };
}

async function buildDualFrame(
  deps: StatusCommandDeps,
  options: StatusCommandOptions,
): Promise<RenderInputs> {
  const isDevMode = await readDevModeSentinel(
    deps.devModeSentinelPath ?? join(profileRootDir(), 'DEV_MODE'),
    deps.readBootId ?? readBootId,
  );

  const showBoth = isDevMode ? true : options.all === true && options.compact !== true;
  const devDeps = options.devDeps;

  if (showBoth && devDeps !== undefined) {
    const [prodFrame, devFrame] = await Promise.all([
      buildFrame(deps, isDevMode, 'prod', options.compact),
      buildFrame(devDeps, isDevMode, 'dev', options.compact),
    ]);
    const combined: RenderInputs = {
      ...prodFrame,
      secondProfile: devFrame,
    };
    return combined;
  }

  return buildFrame(deps, isDevMode, 'prod', options.compact);
}

async function buildFrame(
  deps: StatusCommandDeps,
  isDevMode: boolean,
  profileName: 'prod' | 'dev',
  compact?: boolean,
): Promise<RenderInputs> {
  const exists = await deps.configExists();
  const isLocalBuild = isLocalBuildPath(deps.binaryPath);
  const nowLocal = (deps.now ?? ((): Date => new Date()))();
  const version = deps.currentVersion ?? null;
  const binaryPath = deps.binaryPath ?? null;

  if (!exists) {
    return {
      summary: deriveUnifiedSummary({
        configured: false,
        isDevMode,
        profileName,
        daemonRunning: false,
        daemonInferredAlive: false,
        daemonLastCycleAt: null,
        authFailed: false,
        bufferFull: false,
        bufferFullPendingBytes: null,
        bufferFullThreshold: null,
        sessionStopped: false,
      }),
      snapshot: null,
      notConfigured: true,
      isDevMode,
      isLocalBuild,
      binaryPath,
      nowLocal,
      version,
      compact: isDevMode ? false : compact === true || !isDevMode,
    };
  }

  if (deps.buffer === undefined) {
    return {
      summary: deriveUnifiedSummary({
        configured: true,
        isDevMode,
        profileName,
        daemonRunning: false,
        daemonInferredAlive: false,
        daemonLastCycleAt: null,
        authFailed: false,
        bufferFull: false,
        bufferFullPendingBytes: null,
        bufferFullThreshold: null,
        sessionStopped: false,
      }),
      snapshot: null,
      notConfigured: false,
      isDevMode,
      isLocalBuild,
      binaryPath,
      nowLocal,
      version,
      compact: isDevMode ? false : compact === true || !isDevMode,
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
    isDevMode,
    profileName,
    daemonRunning: snapshot.runtime.isRunning,
    daemonInferredAlive,
    daemonLastCycleAt: snapshot.drainLastCycleAt ?? snapshot.captureLastCycleAt,
    authFailed: snapshot.authFailed,
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
    isLocalBuild,
    binaryPath,
    nowLocal,
    version,
    compact: isDevMode ? false : compact === true || !isDevMode,
  };
}
