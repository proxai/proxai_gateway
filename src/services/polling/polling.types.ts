import type { FetchFn } from 'core/utils';
import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';
import type { PendingPressureResult, PruneResult } from 'services/buffer';
import type { InstallSource } from 'services/config';
import type { HttpClient } from 'services/http';
import type { DrainResult, Pacer } from 'services/uploader';
import type { CoordinatedUpgradeDeps } from 'services/upgrade/coordinated-upgrade.ts';

export interface SourcePollerContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: MinimalLogger;

  minimumMtimeOverride?: Date | null;
  excludedProjects?: readonly string[];
}

export interface SourcePollerError {
  sourcePath: string;
  reason: string;
  table?: string;
}

export interface SourcePollerResult {
  filesProcessed: number;
  capturedBatches: number;
  capturedBytes: number;
  errors: SourcePollerError[];
}

export type SourcePoller = (ctx: SourcePollerContext) => Promise<SourcePollerResult>;

export interface RegisteredSource {
  name: string;
  poll: SourcePoller;
  baseDir?: string;
}

export interface StaleBinaryThresholds {
  warnAfterDays: number;
  pauseAfterDays: number;
}

export interface BufferRetentionPolicy {
  receiptRetentionDays: number;
  failedRetentionDays: number;
  softPauseBytes: number;
  softResumeBytes: number;
}

export interface CapturePolicy {
  maxDecompressedBytes: number;
}

export interface CaptureCycleContext {
  buffer: Database;
  gatewayVersion: string;
  sources: readonly RegisteredSource[];
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  bufferPolicy: BufferRetentionPolicy;
  capturePolicy: CapturePolicy;
  logger?: MinimalLogger;
  minimumMtimeOverride?: Date | null;
  loadDesktopCliSessionIds?: () => Promise<ReadonlySet<string>>;
  loadExcludedProjects?: () => Promise<readonly string[]>;
}

export interface CaptureCycleResult {
  authFailed: boolean;
  bufferFull: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sourceResults: Record<string, SourcePollerResult>;
  pressureResult: PendingPressureResult | null;
}

export interface DrainCycleContext {
  buffer: Database;
  http: HttpClient;
  hostId: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  bufferPolicy: BufferRetentionPolicy;
  pacer?: Pacer;
  logger?: MinimalLogger;
}

export interface DrainCycleResult {
  authFailed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  drainResult: DrainResult | null;
  pruneResult: PruneResult | null;
  pressureResult: PendingPressureResult | null;
}

export interface HeartbeatCycleContext {
  buffer: Database;
  gatewayVersion: string;
  installedAt: string;
  staleBinary: StaleBinaryThresholds;
  updateAvailableSentinelPath?: string;
  logger?: MinimalLogger;
  authFailedSentinelPath?: string;

  versionCheckFetch?: FetchFn;
  versionCheckIntervalMs?: number;

  devMode?: boolean;
  installSource?: InstallSource;
  currentVersion?: string;
  binaryPath?: string;
  exitProcess?: () => void;
  coordinatedUpgradeDeps?: CoordinatedUpgradeDeps;
  coordinatedUpgradeFn?: (
    deps: CoordinatedUpgradeDeps,
  ) => Promise<import('services/upgrade/coordinated-upgrade.ts').CoordinatedUpgradeResult>;
}

export interface HeartbeatCycleResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ranAutoUpgrade: boolean;
}

export interface PollCycleContext {
  buffer: Database;
  http: HttpClient;
  hostId: string;
  gatewayVersion: string;
  sources: readonly RegisteredSource[];
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  updateAvailableSentinelPath?: string;
  installedAt: string;
  staleBinary: StaleBinaryThresholds;
  bufferPolicy: BufferRetentionPolicy;
  capturePolicy: CapturePolicy;
  pacer?: Pacer;
  logger?: MinimalLogger;

  versionCheckFetch?: FetchFn;
  versionCheckIntervalMs?: number;

  devMode?: boolean;
  installSource?: InstallSource;
  currentVersion?: string;
  binaryPath?: string;
  exitProcess?: () => void;

  minimumMtimeOverride?: Date | null;
  loadDesktopCliSessionIds?: () => Promise<ReadonlySet<string>>;
  loadExcludedProjects?: () => Promise<readonly string[]>;
}

export interface PollCycleResult {
  authFailed: boolean;
  bufferFull: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sourceResults: Record<string, SourcePollerResult>;
  drainResult: DrainResult | null;
  pruneResult: PruneResult | null;
  pressureResult: PendingPressureResult | null;
}

export interface DaemonLoopOptions {
  captureIntervalMs?: number;
  drainIntervalMs?: number;
  heartbeatIntervalMs?: number;
  abortSignal?: AbortSignal;
  onCaptureComplete?: (result: CaptureCycleResult) => void;
  onDrainComplete?: (result: DrainCycleResult) => void;
  onHeartbeatComplete?: (result: HeartbeatCycleResult) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  xstateInspect?: boolean | undefined;
  authRecovery?: { baseDelayMs?: number; maxRetries?: number; idleMs?: number };
}
