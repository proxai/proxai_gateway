import type { Database } from 'bun:sqlite';

import type { OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager';
import type {
  CountsBySource,
  DaemonStateSnapshot,
  LastUploadRow,
  SourceCycleResult,
} from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import type { SourceApp } from 'services/contract';

import type { StatusHealth } from 'cli/commands/status/decorators.ts';
import type { UploadBySource } from 'cli/commands/status/render-upload.ts';

export interface StatusCommandDeps {
  output: OutputSink;
  buffer?: Database;
  configPath: string;
  configExists: () => Promise<boolean>;
  bufferFullSentinelPath: string;
  authFailedSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  devModeSentinelPath?: string;
  readBootId?: () => Promise<string>;
  serviceManager?: ServiceManager;
  loadConfig?: (path?: string) => Promise<GatewayConfig>;
  currentVersion?: string;
  binaryPath?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';

export interface StatusCommandOptions {
  json?: boolean;
  all?: boolean;
  compact?: boolean;
  profileName?: ProfileName;
  devDeps?: StatusCommandDeps;
  stdin?: ReadableInputStream;
  intervalMs?: number;
  clearScreen?: boolean;
}

export interface StatusJsonOutput {
  configured: boolean;
  isDevMode: boolean;
  health: string;
  profileName?: ProfileName;
  lastUploads?: LastUploadRow[];
  resyncCount?: number;
  sentinels: {
    authFailed: boolean;
    authFailedReason: string | null;
    authFailedRetryAttempts: number;
    authFailedRetryMax: number;
    authFailedRetryExhausted: boolean;
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
    drainLastCycleAt: string | null;
    drainCyclesTotal: number;
    drainCyclesTotalDurationMs: number;
    lastSuccessAt: string | null;
    lastSuccessBatches: number | null;
    lastSuccessBytes: number | null;
    shippedBySource: UploadBySource;
  };
  system: {
    daemon: {
      isRunning: boolean;
      pid: number | null;
      startedAt: string | null;
      inferredAlive: boolean;
    };
    autoUpgrade: { lastCheckAt: string | null; latestKnownVersion: string | null };
    binaryAge: { installedAt: string | null; days: number | null };
    watchdogInstalled: boolean;
    rescue: {
      consecutiveFailures: number;
      lastRescueAt: string | null;
      circuitBroken: boolean;
    } | null;
    lastResumedAt: string | null;
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
  profileName: ProfileName;
  health: StatusHealth;
  isDevMode: boolean;
  authFailed: boolean;
  authFailedReason: string;
  authFailedDetectedAt: string;
  authFailedRetryAttempts: number;
  authFailedRetryMax: number;
  authFailedRetryExhausted: boolean;
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
  drainLastCycleAt: string | null;
  drainCyclesTotal: number;
  drainCyclesTotalDurationMs: number;
  totalBatchesShipped: number;
  totalBytesShipped: number;
  capturedBytes: number;
  uploadedBytes: number;
  idempotentCount: number;
  shippedBySource: UploadBySource;
  lastSuccessAt: string | null;
  lastSuccessBatches: number | null;
  lastSuccessBytes: number | null;
  lastVersionCheckAt: string | null;
  latestKnownVersion: string | null;
  lastUploads: LastUploadRow[];
  resyncCount: number;
  lastResyncAt: string | null;
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
  watchdogInstalled: boolean;
  rescue: {
    consecutiveFailures: number;
    lastRescueAt: string | null;
    circuitBroken: boolean;
  } | null;
  lastResumedAt: string | null;
}
