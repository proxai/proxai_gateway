import { join } from 'node:path';

import { STRUCTURED_LOG_BASENAME, STRUCTURED_LOG_EXTENSION } from 'core/log';

export function todaysLogPath(logDir: string, now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const date = `${year.toString()}-${month}-${day}`;
  return join(logDir, `${STRUCTURED_LOG_BASENAME}.${date}.1${STRUCTURED_LOG_EXTENSION}`);
}
