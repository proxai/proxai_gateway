import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import type { PendingPressureResult, PruneResult } from 'services/buffer';
import type { HttpClient } from 'services/http';
import type { DrainResult, Pacer } from 'services/uploader';

export interface SourcePollerContext {
  buffer: Database;
  gatewayVersion: string;
  logger?: Logger;

  minimumMtimeOverride?: Date | null;
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
  initialScanWindowDays: number;
}

export interface PollCycleContext {
  buffer: Database;
  http: HttpClient;
  hostId: string;
  gatewayVersion: string;
  sources: readonly RegisteredSource[];
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  installedAt: string;
  staleBinary: StaleBinaryThresholds;
  bufferPolicy: BufferRetentionPolicy;
  capturePolicy: CapturePolicy;
  pacer?: Pacer;
  logger?: Logger;

  minimumMtimeOverride?: Date | null;
}

export interface PollCycleResult {
  paused: boolean;
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

export interface PollLoopOptions {
  intervalMs?: number;
  abortSignal?: AbortSignal;
  onCycleComplete?: (result: PollCycleResult) => void;
}
