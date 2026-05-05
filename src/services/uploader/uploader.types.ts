import type { Database } from 'bun:sqlite';

import type { HttpClient } from 'services/http';

export interface UploaderContext {
  db: Database;
  http: HttpClient;
  hostId: string;
}

export interface AcceptedOutcome {
  kind: 'accepted';
  captureId: string;
  idempotent: boolean;
}

export interface RetriableOutcome {
  kind: 'retriable';
  captureId: string;
  error: string;
  retryAfterMs: number | null;
}

export interface FatalOutcome {
  kind: 'fatal';
  captureId: string;
  error: string;
}

export type UploadOutcome = AcceptedOutcome | RetriableOutcome | FatalOutcome;

export interface DrainOptions {
  maxBatches?: number;
}

export interface DrainResult {
  attempted: number;
  accepted: number;
  retriable: number;
  fatal: number;
  rateLimitedRetryAfterMs: number | null;
}
