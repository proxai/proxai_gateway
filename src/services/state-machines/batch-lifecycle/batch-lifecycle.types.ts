import type { SourceApp } from 'services/contract';

export type BatchLifecyclePhase =
  | 'pending'
  | 'uploading'
  | 'verifying_auth'
  | 'retriable_pending'
  | 'delivered'
  | 'recovered'
  | 'failed'
  | 'pruned';

export type RetriableReason = 'rate_limit' | 'service_unavailable' | 'network' | 'auth_unconfirmed';

export type FailureReason = 'validation' | 'oversized' | 'auth_invalid' | 'unknown';

export interface BatchIdentity {
  readonly captureId: string;
  readonly sourceApp: SourceApp;
  readonly sourcePathHash: string;
  readonly watermarkStart: number;
  readonly watermarkEnd: number;
  readonly compressedBytes: number;
}

export interface BatchLifecycleInput {
  readonly batch: BatchIdentity;
}

export interface BatchLifecycleContext {
  readonly batch: BatchIdentity;
  attempts: number;
  lastError: string | null;
  lastRetriableReason: RetriableReason | null;
  lastFailureReason: FailureReason | null;
  idempotentOnServer: boolean;
  recoveredServerWatermarkEnd: number | null;
  retryAfterMs: number | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  prunedAtUtc: string | null;
}

export type BatchLifecycleEvent =
  | { type: 'DRAIN_PICKS_UP' }
  | { type: 'ACCEPTED'; idempotent: boolean; deliveredAtUtc: string }
  | { type: 'WATERMARK_REGRESSED'; serverWatermarkEnd: number }
  | { type: 'VALIDATION_FAILED'; error: string; failedAtUtc: string }
  | { type: 'OVERSIZED'; error: string; failedAtUtc: string }
  | { type: 'AUTH_ERROR'; error: string }
  | { type: 'RATE_LIMITED'; error: string; retryAfterMs: number | null }
  | { type: 'SERVICE_UNAVAILABLE'; error: string; retryAfterMs: number | null }
  | { type: 'NETWORK_ERROR'; error: string }
  | { type: 'UNKNOWN_ERROR'; error: string; failedAtUtc: string }
  | { type: 'VERIFY_THREW_AUTH'; error: string; failedAtUtc: string }
  | { type: 'VERIFY_SUCCESS_FALSE'; error: string; failedAtUtc: string }
  | { type: 'VERIFY_SUCCESS_TRUE'; error: string }
  | { type: 'VERIFY_THREW_OTHER'; error: string }
  | { type: 'RETURN_TO_QUEUE' }
  | { type: 'RETENTION_EXPIRED'; prunedAtUtc: string };
