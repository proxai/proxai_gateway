import { sentinelHandle } from 'core/io/fs';

export interface SessionStoppedPayload {
  bootId: string;
  setAt: string;
}

interface OnDiskPayload {
  boot_id: string;
  set_at: string;
}

export async function writeSessionStoppedSentinel(
  sentinelPath: string,
  payload: SessionStoppedPayload,
): Promise<void> {
  const onDisk: OnDiskPayload = {
    boot_id: payload.bootId,
    set_at: payload.setAt,
  };
  await sentinelHandle(sentinelPath).write(JSON.stringify(onDisk));
}

export async function readSessionStoppedSentinel(
  sentinelPath: string,
): Promise<SessionStoppedPayload | null> {
  const text = await sentinelHandle(sentinelPath).read();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const bootId = typeof parsed['boot_id'] === 'string' ? parsed['boot_id'] : '';
    const setAt = typeof parsed['set_at'] === 'string' ? parsed['set_at'] : '';
    if (bootId.length === 0) return null;
    return { bootId, setAt };
  } catch {
    return null;
  }
}

export async function clearSessionStoppedSentinel(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}

/**
 * Returns true iff the sentinel exists AND its boot_id matches `currentBootId`.
 * If a sentinel exists but its boot_id does not match (i.e. it was set in a
 * previous boot session), it is removed as a side effect and false is returned.
 */
export async function isCurrentSessionStopped(
  sentinelPath: string,
  currentBootId: string,
): Promise<boolean> {
  const payload = await readSessionStoppedSentinel(sentinelPath);
  if (payload === null) return false;
  if (payload.bootId === currentBootId) return true;
  await clearSessionStoppedSentinel(sentinelPath);
  return false;
}
