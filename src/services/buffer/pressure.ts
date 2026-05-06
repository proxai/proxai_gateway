import type { Database } from 'bun:sqlite';

import { totalPendingBytes } from 'services/buffer/stats.ts';

export interface PendingPressureInput {
  db: Database;
  softPauseBytes: number;
  softResumeBytes: number;
}

export interface PendingPressureResult {
  pendingBytes: number;
  shouldPause: boolean;
  shouldResume: boolean;
}

export function checkPendingPressure(input: PendingPressureInput): PendingPressureResult {
  const pendingBytes = totalPendingBytes(input.db);
  return {
    pendingBytes,
    shouldPause: pendingBytes > input.softPauseBytes,
    shouldResume: pendingBytes < input.softResumeBytes,
  };
}
