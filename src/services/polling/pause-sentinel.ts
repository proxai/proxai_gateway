import { sentinelHandle } from 'core/io/fs';

export async function isPaused(sentinelPath: string): Promise<boolean> {
  return sentinelHandle(sentinelPath).exists();
}

export async function pausePolling(sentinelPath: string, reason = ''): Promise<void> {
  await sentinelHandle(sentinelPath).write(reason);
}

export async function resumePolling(sentinelPath: string): Promise<void> {
  await sentinelHandle(sentinelPath).remove();
}

export async function readPauseReason(sentinelPath: string): Promise<string> {
  return sentinelHandle(sentinelPath).read();
}
