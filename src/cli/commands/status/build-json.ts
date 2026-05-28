import { daysSince } from 'core/utils';

import { inferDaemonAlive } from 'cli/commands/status/daemon-liveness.ts';
import type { StatusJsonOutput, StatusSnapshot } from 'cli/commands/status/status.types.ts';

export function buildEmptyStatusJson(): StatusJsonOutput {
  return {
    configured: false,
    isDevMode: false,
    health: 'inactive',
    sentinels: {
      authFailed: false,
      authFailedReason: null,
      bufferFull: false,
      bufferFullPendingBytes: null,
      sessionStopped: false,
      updateAvailable: null,
    },
    capture: null,
    buffer: {
      pending: 0,
      pendingBytes: 0,
      failed: 0,
      failedBytes: 0,
      delivered: 0,
      quarantinedCount: 0,
      bufferFull: false,
      lastPruneAt: null,
      sourceCounts: null,
    },
    upload: {
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      lastCycleDurationMs: null,
      attempted: null,
      accepted: null,
      retriable: null,
      fatal: null,
      recovered: null,
      lastUploadError: null,
      consecutiveRetriableBreak: null,
      totalBatchesShipped: 0,
      totalBytesShipped: 0,
      captureCyclesTotal: 0,
      captureCyclesWithErrors: 0,
      captureLastCycleAt: null,
      drainLastCycleAt: null,
      drainCyclesTotal: 0,
      drainCyclesTotalDurationMs: 0,
      lastSuccessAt: null,
      lastSuccessBatches: null,
      lastSuccessBytes: null,
      shippedBySource: {},
    },
    system: {
      daemon: { isRunning: false, pid: null, startedAt: null, inferredAlive: false },
      autoUpgrade: { lastCheckAt: null, latestKnownVersion: null },
      binaryAge: { installedAt: null, days: null },
    },
    history: null,
  };
}

export function buildStatusJson(snapshot: StatusSnapshot): StatusJsonOutput {
  const installedAt = snapshot.cfg?.account.installedAt ?? null;
  return {
    configured: true,
    isDevMode: snapshot.isDevMode,
    health: snapshot.health,
    profileName: snapshot.profileName,
    lastUploads: snapshot.lastUploads,
    resyncCount: snapshot.resyncCount,
    sentinels: {
      authFailed: snapshot.authFailed,
      authFailedReason: snapshot.authFailedReason.length > 0 ? snapshot.authFailedReason : null,
      bufferFull: snapshot.bufferFull,
      bufferFullPendingBytes: snapshot.bufferFullPendingBytes,
      sessionStopped: snapshot.sessionStopped,
      updateAvailable:
        snapshot.updateAvailable === null
          ? null
          : {
              latestVersion: snapshot.updateAvailable.latestVersion,
              currentVersion: snapshot.updateAvailable.currentVersion,
            },
    },
    capture: snapshot.daemonState?.lastSourceCaptures ?? null,
    buffer: {
      pending: snapshot.counts.pending,
      pendingBytes: snapshot.pendingBytes,
      failed: snapshot.counts.failed,
      failedBytes: snapshot.failedBytes,
      delivered: snapshot.counts.delivered,
      quarantinedCount: snapshot.quarantinedCount,
      bufferFull: snapshot.bufferFull,
      lastPruneAt: snapshot.lastPruneAt,
      sourceCounts: snapshot.sourceCounts,
    },
    upload: {
      lastCycleStartedAt: snapshot.daemonState?.lastCycleStartedAt ?? null,
      lastCycleCompletedAt: snapshot.daemonState?.lastCycleCompletedAt ?? null,
      lastCycleDurationMs: snapshot.daemonState?.lastCycleDurationMs ?? null,
      attempted: snapshot.daemonState?.lastDrainAttempted ?? null,
      accepted: snapshot.daemonState?.lastDrainAccepted ?? null,
      retriable: snapshot.daemonState?.lastDrainRetriable ?? null,
      fatal: snapshot.daemonState?.lastDrainFatal ?? null,
      recovered: snapshot.daemonState?.lastDrainRecovered ?? null,
      lastUploadError: snapshot.daemonState?.lastUploadError ?? null,
      consecutiveRetriableBreak: snapshot.daemonState?.lastConsecutiveRetriableBreak ?? null,
      totalBatchesShipped: snapshot.totalBatchesShipped,
      totalBytesShipped: snapshot.totalBytesShipped,
      captureCyclesTotal: snapshot.captureCyclesTotal,
      captureCyclesWithErrors: snapshot.captureCyclesWithErrors,
      captureLastCycleAt: snapshot.captureLastCycleAt,
      drainLastCycleAt: snapshot.drainLastCycleAt,
      drainCyclesTotal: snapshot.drainCyclesTotal,
      drainCyclesTotalDurationMs: snapshot.drainCyclesTotalDurationMs,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastSuccessBatches: snapshot.lastSuccessBatches,
      lastSuccessBytes: snapshot.lastSuccessBytes,
      shippedBySource: snapshot.shippedBySource,
    },
    system: {
      daemon: {
        isRunning: snapshot.runtime.isRunning,
        pid: snapshot.runtime.pid,
        startedAt:
          snapshot.runtime.startedAt === null ? null : snapshot.runtime.startedAt.toISOString(),
        inferredAlive: inferDaemonAlive(
          snapshot.drainLastCycleAt,
          snapshot.captureLastCycleAt,
          snapshot.now,
        ),
      },
      autoUpgrade: {
        lastCheckAt: snapshot.lastVersionCheckAt,
        latestKnownVersion: snapshot.latestKnownVersion,
      },
      binaryAge: {
        installedAt,
        days: installedAt === null ? null : daysSince(installedAt, snapshot.now),
      },
    },
    history: snapshot.history,
  };
}
