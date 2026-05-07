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

// Why a retriable outcome was raised. Drives pacer notifications:
//   * 'rate_limit'         -> notify429 (+ Retry-After if present)
//   * 'service_unavailable' -> notifyServiceUnavailable (+ Retry-After if present)
//   * 'auth_unconfirmed'    -> no pacer signal; verify-key was inconclusive,
//                              the upload itself is being retried opportunistically
//   * 'network'             -> no pacer signal; transport-level fault, not server distress
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
