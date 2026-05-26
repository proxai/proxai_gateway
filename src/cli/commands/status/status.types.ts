import type { Database } from 'bun:sqlite';

import type { OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { CountsBySource, DaemonStateSnapshot, SourceCycleResult } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import type { SourceApp } from 'services/contract';

import type { StatusHealth } from 'cli/commands/status/decorators.ts';
import type { UploadBySource } from 'cli/commands/status/render-upload.ts';

export interface StatusCommandDeps {
  output: OutputSink;
  buffer?: Database;
  configPath: string;
  configExists: () => Promise<boolean>;
  pauseSentinelPath: string;
  bufferFullSentinelPath: string;
  authFailedSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  devModeSentinelPath?: string;
  serviceManager?: ServiceManager;
  loadConfig?: (path?: string) => Promise<GatewayConfig>;
  currentVersion?: string;
  now?: () => Date;
}

import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';

export interface StatusCommandOptions {
  json?: boolean;
  verbose?: boolean;
  stdin?: ReadableInputStream;
  intervalMs?: number;
  clearScreen?: boolean;
}

export interface StatusJsonOutput {
  configured: boolean;
  isDevMode: boolean;
  health: string;
  sentinels: {
    paused: boolean;
    pausedReason: string | null;
    authFailed: boolean;
    authFailedReason: string | null;
    bufferFull: boolean;
    bufferFullPendingBytes: number | null;
    sessionStopped: boolean;
    updateAvailable: { latestVersion: string; currentVersion: string } | null;
  };
  capture: Record<string, SourceCycleResult> | null;
  buffer: {
    pending: number;
    pendingBytes: number;
    failed: number;
    failedBytes: number;
    delivered: number;
    quarantinedCount: number;
    bufferFull: boolean;
    lastPruneAt: string | null;
    sourceCounts: CountsBySource | null;
  };
  upload: {
    lastCycleStartedAt: string | null;
    lastCycleCompletedAt: string | null;
    lastCycleDurationMs: number | null;
    attempted: number | null;
    accepted: number | null;
    retriable: number | null;
    fatal: number | null;
    recovered: number | null;
    lastUploadError: string | null;
    consecutiveRetriableBreak: boolean | null;
    totalBatchesShipped: number;
    totalBytesShipped: number;
    captureCyclesTotal: number;
    captureCyclesWithErrors: number;
    captureLastCycleAt: string | null;
    drainCyclesTotal: number;
    drainCyclesTotalDurationMs: number;
    lastSuccessAt: string | null;
    lastSuccessBatches: number | null;
    lastSuccessBytes: number | null;
    shippedBySource: UploadBySource;
  };
  system: {
    daemon: { isRunning: boolean; pid: number | null; startedAt: string | null };
    autoUpgrade: { lastCheckAt: string | null; latestKnownVersion: string | null };
    binaryAge: { installedAt: string | null; days: number | null };
  };
  history: {
    totalBytesCaptured: number;
    totalBytesSent: number;
    totalRecordsCaptured: number;
    totalRecordsSent: number;
    conversationsCaptured: Record<SourceApp, number>;
  } | null;
}

export interface StatusSnapshot {
  health: StatusHealth;
  isDevMode: boolean;
  paused: boolean;
  pausedReason: string;
  authFailed: boolean;
  authFailedReason: string;
  authFailedDetectedAt: string;
  bufferFull: boolean;
  bufferFullPendingBytes: number | null;
  bufferFullThreshold: number | null;
  sessionStopped: boolean;
  sessionStoppedSetAt: string | null;
  updateAvailable: { latestVersion: string; currentVersion: string } | null;
  hasRecentActivity: boolean;
  counts: { pending: number; failed: number; delivered: number };
  pendingBytes: number;
  failedBytes: number;
  quarantinedCount: number;
  sourceCounts: CountsBySource;
  lastPruneAt: string | null;
  daemonState: DaemonStateSnapshot | null;
  captureCyclesTotal: number;
  captureCyclesWithErrors: number;
  captureLastCycleAt: string | null;
  drainCyclesTotal: number;
  drainCyclesTotalDurationMs: number;
  totalBatchesShipped: number;
  totalBytesShipped: number;
  shippedBySource: UploadBySource;
  lastSuccessAt: string | null;
  lastSuccessBatches: number | null;
  lastSuccessBytes: number | null;
  lastVersionCheckAt: string | null;
  latestKnownVersion: string | null;
  runtime: { isRunning: boolean; pid: number | null; startedAt: Date | null };
  cfg: GatewayConfig | null;
  now: Date;
  history: {
    totalBytesCaptured: number;
    totalBytesSent: number;
    totalRecordsCaptured: number;
    totalRecordsSent: number;
    conversationsCaptured: Record<SourceApp, number>;
  } | null;
}
