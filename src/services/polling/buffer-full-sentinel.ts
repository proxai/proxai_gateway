import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';

export interface BufferFullSentinelPayload {
  pendingBytes: number;
  threshold: number;
  setAt: string;
}

export async function isBufferFull(sentinelPath: string): Promise<boolean> {
  return sentinelHandle(sentinelPath).exists();
}

export async function writeBufferFullSentinel(
  sentinelPath: string,
  payload: { pendingBytes: number; threshold: number },
  now: () => string = nowIsoUtc,
): Promise<void> {
  const body = JSON.stringify({
    pending_bytes: payload.pendingBytes,
    threshold: payload.threshold,
    set_at: now(),
  });
  await sentinelHandle(sentinelPath).write(body);
}

export async function readBufferFullSentinel(
  sentinelPath: string,
): Promise<BufferFullSentinelPayload | null> {
  const text = await sentinelHandle(sentinelPath).read();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pendingBytes = typeof parsed['pending_bytes'] === 'number' ? parsed['pending_bytes'] : 0;
    const threshold = typeof parsed['threshold'] === 'number' ? parsed['threshold'] : 0;
    const setAt = typeof parsed['set_at'] === 'string' ? parsed['set_at'] : '';
    return { pendingBytes, threshold, setAt };
  } catch {
    return null;
  }
}

export async function clearBufferFullSentinel(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}
