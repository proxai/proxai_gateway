import type { BackoffOptions } from 'core/utils/utils.types.ts';

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 30_000,
  maxMs: 60 * 60 * 1000,
  multiplier: 2,
  jitter: 0.2,
};
