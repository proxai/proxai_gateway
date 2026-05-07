import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import type { HttpClient } from 'services/http';
import type { Pacer } from 'services/uploader/pacer.ts';

export interface UploaderContext {
  db: Database;
  http: HttpClient;
  hostId: string;
  authFailedSentinelPath?: string;
  logger?: Logger;
  pacer?: Pacer;
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
}

export interface DrainResult {
  attempted: number;
  accepted: number;
  retriable: number;
  fatal: number;
  recovered: number;
  rateLimitedRetryAfterMs: number | null;
}
