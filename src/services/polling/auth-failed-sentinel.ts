import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';

export interface AuthFailedSentinelPayload {
  reason: string;
  detectedAt: string;
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

export async function readAuthFailedSentinel(
  sentinelPath: string,
): Promise<AuthFailedSentinelPayload | null> {
  const text = await sentinelHandle(sentinelPath).read();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : '';
    const detectedAt = typeof parsed['detected_at'] === 'string' ? parsed['detected_at'] : '';
    return { reason, detectedAt };
  } catch {
    return { reason: text, detectedAt: '' };
  }
}

export async function clearAuthFailedSentinel(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}
