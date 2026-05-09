import type { Database } from 'bun:sqlite';

import {
  countByStatus,
  countsBySource,
  getDaemonState,
  getLastPruneAt,
  getMetadata,
  getMetadataWithFallback,
  METADATA_KEYS,
  readNumber,
  readNumberOrNull,
  readNumberWithFallback,
  totalFailedBytes,
  totalPendingBytes,
  uploadBatchesShippedKey,
  uploadBytesShippedKey,
} from 'services/buffer';
import { loadConfigFromFile } from 'services/config';
import {
  isAuthFailed,
  isBufferFull,
  isPaused,
  readAuthFailedSentinel,
  readBufferFullSentinel,
  readPauseReason,
  readSessionStoppedSentinel,
  readUpdateAvailableSentinel,
} from 'services/polling';

import { deriveHealth } from 'cli/commands/status/derive-health.ts';
import type { UploadBySource } from 'cli/commands/status/render-upload.ts';
import type { StatusCommandDeps, StatusSnapshot } from 'cli/commands/status/status.types.ts';

const SOURCE_ORDER: ('claude-code' | 'cursor' | 'codex' | 'gemini-cli')[] = [
  'claude-code',
  'cursor',
  'codex',
  'gemini-cli',
];

export function readShippedBySource(db: Database): UploadBySource {
  const result: UploadBySource = {};
  for (const app of SOURCE_ORDER) {
    const batches = readNumber(db, uploadBatchesShippedKey(app));
    const bytes = readNumber(db, uploadBytesShippedKey(app));
    if (batches > 0 || bytes > 0) {
      result[app] = { batches, bytes };
    }
  }
  return result;
}

export async function gatherStatusSnapshot(
  deps: StatusCommandDeps,
  buffer: Database,
): Promise<StatusSnapshot> {
  const counts = countByStatus(buffer);
  const pendingBytes = totalPendingBytes(buffer);
  const failedBytes = totalFailedBytes(buffer);
  const sourceCounts = countsBySource(buffer);
  const lastPruneAt = getLastPruneAt(buffer);
  const daemonState = getDaemonState(buffer);

  const captureCyclesTotal = readNumberWithFallback(
    buffer,
    METADATA_KEYS.captureCyclesTotal,
    METADATA_KEYS.cyclesTotal,
  );
  const captureCyclesWithErrors = readNumberWithFallback(
    buffer,
    METADATA_KEYS.captureCyclesWithErrors,
    METADATA_KEYS.cyclesWithErrors,
  );
  const captureLastCycleAt = getMetadataWithFallback(
    buffer,
    METADATA_KEYS.captureLastCycleAt,
    null,
  );
  const drainCyclesTotal = readNumber(buffer, METADATA_KEYS.drainCyclesTotal);
  const drainCyclesTotalDurationMs = readNumber(buffer, METADATA_KEYS.drainLastCycleDurationMs);
  const totalBatchesShipped = readNumberWithFallback(
    buffer,
    METADATA_KEYS.drainTotalBatchesShipped,
    METADATA_KEYS.uploadTotalBatchesShipped,
  );
  const totalBytesShipped = readNumberWithFallback(
    buffer,
    METADATA_KEYS.drainTotalBytesShipped,
    METADATA_KEYS.uploadTotalBytesShipped,
  );
  const shippedBySource = readShippedBySource(buffer);
  const lastSuccessAt = getMetadata(buffer, METADATA_KEYS.uploadLastSuccessAt);
  const lastSuccessBatches = readNumberOrNull(buffer, METADATA_KEYS.uploadLastSuccessBatches);
  const lastSuccessBytes = readNumberOrNull(buffer, METADATA_KEYS.uploadLastSuccessBytes);
  const lastVersionCheckAt = getMetadata(buffer, METADATA_KEYS.lastVersionCheckAt);
  const latestKnownVersion = getMetadata(buffer, METADATA_KEYS.latestKnownVersion);

  const paused = await isPaused(deps.pauseSentinelPath);
  const pausedReason = paused ? (await readPauseReason(deps.pauseSentinelPath)).trim() : '';
  const authFailed = await isAuthFailed(deps.authFailedSentinelPath);
  const authFailedPayload = authFailed
    ? await readAuthFailedSentinel(deps.authFailedSentinelPath)
    : null;
  const bufferFullFlag = await isBufferFull(deps.bufferFullSentinelPath);
  const bufferFullPayload = bufferFullFlag
    ? await readBufferFullSentinel(deps.bufferFullSentinelPath)
    : null;
  const sessionStoppedPayload = await readSessionStoppedSentinel(deps.sessionStoppedSentinelPath);
  const sessionStopped = sessionStoppedPayload !== null;
  const updateAvailable =
    deps.updateAvailableSentinelPath !== undefined
      ? await readUpdateAvailableSentinel(deps.updateAvailableSentinelPath)
      : null;

  const now = (deps.now ?? ((): Date => new Date()))();

  let cfg = null;
  if (deps.loadConfig !== undefined) {
    try {
      cfg = await deps.loadConfig(deps.configPath);
    } catch {
      cfg = null;
    }
  } else {
    try {
      cfg = await loadConfigFromFile(deps.configPath);
    } catch {
      cfg = null;
    }
  }

  let runtime: StatusSnapshot['runtime'] = { isRunning: false, pid: null, startedAt: null };
  if (deps.serviceManager !== undefined) {
    try {
      const isRunning = await deps.serviceManager.isRunning();
      const info = await deps.serviceManager.runtimeInfo();
      runtime = { isRunning, pid: info.pid, startedAt: info.startedAt };
    } catch {
      runtime = { isRunning: false, pid: null, startedAt: null };
    }
  }

  const hasRecentActivity = daemonState !== null && daemonState.lastCycleCompletedAt !== null;
  const health = deriveHealth({
    paused,
    authFailed,
    bufferFull: bufferFullFlag,
    sessionStopped,
    hasRecentActivity,
    drain: daemonState,
  });

  return {
    health,
    paused,
    pausedReason,
    authFailed,
    authFailedReason: authFailedPayload?.reason ?? '',
    authFailedDetectedAt: authFailedPayload?.detectedAt ?? '',
    bufferFull: bufferFullFlag,
    bufferFullPendingBytes: bufferFullPayload?.pendingBytes ?? null,
    bufferFullThreshold: bufferFullPayload?.threshold ?? null,
    sessionStopped,
    sessionStoppedSetAt: sessionStoppedPayload?.setAt ?? null,
    updateAvailable,
    hasRecentActivity,
    counts,
    pendingBytes,
    failedBytes,
    sourceCounts,
    lastPruneAt,
    daemonState,
    captureCyclesTotal,
    captureCyclesWithErrors,
    captureLastCycleAt,
    drainCyclesTotal,
    drainCyclesTotalDurationMs,
    totalBatchesShipped,
    totalBytesShipped,
    shippedBySource,
    lastSuccessAt,
    lastSuccessBatches,
    lastSuccessBytes,
    lastVersionCheckAt,
    latestKnownVersion,
    runtime,
    cfg,
    now,
  };
}
