export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  jitter: number;
}

export type ErrorCategory =
  | 'validation'
  | 'auth'
  | 'rate-limit'
  | 'retriable'
  | 'network'
  | 'fatal';
