export type PacerFlowPhase =
  | 'ready'
  | 'applying_retry_after'
  | 'applying_429_backoff'
  | 'applying_5xx_backoff'
  | 'applying_token_bucket'
  | 'debiting';

export interface PacerInput {
  readonly maxBatchesPerSec: number;
  readonly maxBytesPerMinute: number;
}

export interface PacerContext {
  readonly maxBatchesPerSec: number;
  readonly maxBytesPerMinute: number;
  retryAfterUntilMs: number | null;
  rate429Step: number;
  rate5xxStep: number;
  rate5xxFloorMs: number;
  pendingNotify429: boolean;
  pendingNotify5xx: boolean;
  rateTokens: number;
  bytesTokens: number;
  lastAcquireBytes: number | null;
  lastDebitedAtMs: number | null;
}

export type PacerEvent =
  | { type: 'ACQUIRE_STARTED'; payloadBytes: number }
  | { type: 'ENTER_RETRY_AFTER' }
  | { type: 'ENTER_429_BACKOFF' }
  | { type: 'ENTER_5XX_BACKOFF' }
  | { type: 'ENTER_TOKEN_BUCKET' }
  | { type: 'ENTER_DEBITING' }
  | { type: 'ACQUIRE_COMPLETE'; rateTokens: number; bytesTokens: number; debitedAtMs: number }
  | { type: 'NOTIFY_RETRY_AFTER'; untilMs: number }
  | { type: 'NOTIFY_429' }
  | { type: 'NOTIFY_5XX'; floorMs: number }
  | { type: 'CLEAR_429_PENDING' }
  | { type: 'CLEAR_5XX_PENDING' };
