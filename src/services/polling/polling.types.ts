import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import type { HttpClient } from 'services/http';
import type { DrainResult } from 'services/uploader';

export interface SourcePollerContext {
  buffer: Database;
  gatewayVersion: string;
  logger?: Logger;
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

export interface PollCycleContext {
  buffer: Database;
  http: HttpClient;
  hostId: string;
  gatewayVersion: string;
  sources: readonly RegisteredSource[];
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  installedAt: string;
  staleBinary: StaleBinaryThresholds;
  logger?: Logger;
}

export interface PollCycleResult {
  paused: boolean;
  authFailed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sourceResults: Record<string, SourcePollerResult>;
  drainResult: DrainResult | null;
}

export interface PollLoopOptions {
  intervalMs?: number;
  abortSignal?: AbortSignal;
  onCycleComplete?: (result: PollCycleResult) => void;
}
