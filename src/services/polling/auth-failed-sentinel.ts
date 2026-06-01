import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';

export interface AuthRecoveryState {
  attempts: number;
  maxRetries: number;
  exhausted: boolean;
  lastError: string | null;
}

export interface AuthFailedSentinelPayload {
  reason: string;
  detectedAt: string;
  retry: AuthRecoveryState | null;
}

export async function isAuthFailed(sentinelPath: string): Promise<boolean> {
  return sentinelHandle(sentinelPath).exists();
}

export async function writeAuthFailedSentinel(
  sentinelPath: string,
  reason: string,
  now: () => string = nowIsoUtc,
): Promise<void> {
  const payload = JSON.stringify({ reason, detected_at: now() });
  await sentinelHandle(sentinelPath).write(payload);
}

function parseRetry(value: unknown): AuthRecoveryState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const attempts = typeof r['attempts'] === 'number' ? r['attempts'] : 0;
  const maxRetries = typeof r['max_retries'] === 'number' ? r['max_retries'] : 0;
  const exhausted = r['exhausted'] === true;
  const lastError = typeof r['last_error'] === 'string' ? r['last_error'] : null;
  return { attempts, maxRetries, exhausted, lastError };
}

export async function readAuthFailedSentinel(
  sentinelPath: string,
): Promise<AuthFailedSentinelPayload | null> {
  const text = await sentinelHandle(sentinelPath).read();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
    const detectedAt = typeof parsed['detected_at'] === 'string' ? parsed['detected_at'] : '';
    return { reason, detectedAt, retry: parseRetry(parsed['retry']) };
  } catch {
    return { reason: text, detectedAt: '', retry: null };
  }
}

/**
 * Merge recovery progress into the existing AUTH_FAILED sentinel, preserving the
 * original `reason` / `detected_at`. No-op when the sentinel has already been
 * cleared (e.g. `setup new` ran) so a recovery write never resurrects a sentinel
 * the user just removed.
 */
export async function recordAuthRecoveryState(
  sentinelPath: string,
  state: AuthRecoveryState,
): Promise<void> {
  const existing = await readAuthFailedSentinel(sentinelPath);
  if (existing === null) return;
  const payload = JSON.stringify({
    reason: existing.reason,
    detected_at: existing.detectedAt,
    retry: {
      attempts: state.attempts,
      max_retries: state.maxRetries,
      exhausted: state.exhausted,
      last_error: state.lastError,
    },
  });
  await sentinelHandle(sentinelPath).write(payload);
}

export async function clearAuthFailedSentinel(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}
