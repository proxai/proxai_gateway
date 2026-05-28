import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';

import {
  countByStatus,
  countCapturedConversations,
  countQuarantined,
  countsBySource,
  derivedCapturedBytes,
  derivedUploadStats,
  getDaemonState,
  getLastPruneAt,
  getMetadata,
  getMetadataWithFallback,
  METADATA_KEYS,
  readNumber,
  readNumberWithFallback,
  totalFailedBytes,
  totalPendingBytes,
} from 'services/buffer';
import { loadConfigFromFile } from 'services/config';
import {
  isAuthFailed,
  isBufferFull,
  readAuthFailedSentinel,
  readBufferFullSentinel,
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
  const stats = derivedUploadStats(db);
  const result: UploadBySource = {};
  for (const app of SOURCE_ORDER) {
    const totals = stats.bySource[app];
    if (totals !== undefined && (totals.batches > 0 || totals.bytes > 0)) {
      result[app] = { batches: totals.batches, bytes: totals.bytes };
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
  const quarantinedCount = countQuarantined(buffer);
  const sourceCounts = countsBySource(buffer);
  const lastPruneAt = getLastPruneAt(buffer);
  const daemonState = getDaemonState(buffer);
  const conversationsCaptured = countCapturedConversations(buffer);

  const uploadStats = derivedUploadStats(buffer);
  const totalBatchesShipped = uploadStats.totalBatchesUploaded;
  const totalBytesShipped = uploadStats.totalBytesUploaded;
  const shippedBySource = readShippedBySource(buffer);
  const lastSuccessAt = uploadStats.lastSuccessAt;
  const capturedBytes = derivedCapturedBytes(buffer, totalBytesShipped);

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
  const drainLastCycleAt = getMetadata(buffer, METADATA_KEYS.drainLastCycleAt);
  const drainCyclesTotal = readNumber(buffer, METADATA_KEYS.drainCyclesTotal);
  const drainCyclesTotalDurationMs = readNumber(buffer, METADATA_KEYS.drainLastCycleDurationMs);
  const lastVersionCheckAt = getMetadata(buffer, METADATA_KEYS.lastVersionCheckAt);
  const latestKnownVersion = getMetadata(buffer, METADATA_KEYS.latestKnownVersion);

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
    authFailed,
    bufferFull: bufferFullFlag,
    sessionStopped,
    hasRecentActivity,
    drain: daemonState,
  });

  const isDevMode = await readDevModeSentinel(
    deps.devModeSentinelPath ?? join(profileRootDir(), 'DEV_MODE'),
  );

  return {
    health,
    isDevMode,
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
    quarantinedCount,
    sourceCounts,
    lastPruneAt,
    daemonState,
    captureCyclesTotal,
    captureCyclesWithErrors,
    captureLastCycleAt,
    drainLastCycleAt,
    drainCyclesTotal,
    drainCyclesTotalDurationMs,
    totalBatchesShipped,
    totalBytesShipped,
    shippedBySource,
    lastSuccessAt,
    lastSuccessBatches: null,
    lastSuccessBytes: null,
    lastVersionCheckAt,
    latestKnownVersion,
    runtime,
    cfg,
    now,
    history: {
      totalBytesCaptured: capturedBytes,
      totalBytesSent: totalBytesShipped,
      totalRecordsCaptured: totalBatchesShipped + counts.pending + counts.failed,
      totalRecordsSent: totalBatchesShipped,
      conversationsCaptured,
    },
  };
}
