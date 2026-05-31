import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';
import type { SourceApp } from 'services/contract';
import type { HttpClient } from 'services/http';
import type { Pacer } from 'services/uploader/pacer.ts';
import type { PromptExtractInput, PromptExtractResult } from 'services/prompt-extract';

export interface UploaderContext {
  db: Database;
  http: HttpClient;
  hostId: string;
  authFailedSentinelPath?: string;
  logger?: MinimalLogger;
  pacer?: Pacer;
  writeAuthFailedSentinelFn?: (sentinelPath: string, reason: string) => Promise<void>;
  // Injectable so tests force an extract failure without globally mocking
  // services/prompt-extract — a process-wide mock leaks into other files'
  // prompt-extract tests. Defaults to the real extractUserPrompt.
  extractUserPrompt?: (input: PromptExtractInput) => PromptExtractResult;
}

export interface AcceptedOutcome {
  kind: 'accepted';
  captureId: string;
  idempotent: boolean;
}

export type RetriableReason = 'rate_limit' | 'service_unavailable' | 'auth_unconfirmed' | 'network';

export interface RetriableOutcome {
  kind: 'retriable';
  captureId: string;
  error: string;
  retryAfterMs: number | null;
  reason: RetriableReason;
}

export interface FatalOutcome {
  kind: 'fatal';
  captureId: string;
  error: string;
}

export interface RecoveredOutcome {
  kind: 'recovered';
  captureId: string;
}

export type UploadOutcome = AcceptedOutcome | RetriableOutcome | FatalOutcome | RecoveredOutcome;

export interface DrainOptions {
  maxBatches?: number;
  maxConsecutiveRetriable?: number;
}

export interface DrainSourceTotals {
  batches: number;
  bytes: number;
}

export type AcceptedBySource = Partial<Record<SourceApp, DrainSourceTotals>>;

export interface DrainResult {
  attempted: number;
  accepted: number;
  acceptedBytes: number;
  acceptedBySource: AcceptedBySource;
  retriable: number;
  fatal: number;
  recovered: number;
  lastRetriableRetryAfterMs: number | null;
  consecutiveRetriableBreak: boolean;
  lastUploadError: string | null;
}
