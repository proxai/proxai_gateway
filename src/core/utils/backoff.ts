import { DEFAULT_BACKOFF } from 'core/utils/utils.constants.ts';
import type { BackoffOptions } from 'core/utils/utils.types.ts';

export function* exponentialBackoff(opts: Partial<BackoffOptions> = {}): Generator<number> {
  const cfg = { ...DEFAULT_BACKOFF, ...opts };
  let delay = cfg.initialMs;
  while (true) {
    const noise = delay * cfg.jitter * (Math.random() * 2 - 1);
    yield Math.max(0, Math.floor(delay + noise));
    delay = Math.min(delay * cfg.multiplier, cfg.maxMs);
  }
}

export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }

  const epochMs = Date.parse(trimmed);
  if (Number.isFinite(epochMs)) {
    return Math.max(0, epochMs - now);
  }

  return null;
}
