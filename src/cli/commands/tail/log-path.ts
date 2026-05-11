import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { STRUCTURED_LOG_BASENAME, STRUCTURED_LOG_EXTENSION } from 'core/log';

export function todaysLogPath(logDir: string, now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const date = `${year.toString()}-${month}-${day}`;
  const ext = STRUCTURED_LOG_EXTENSION.startsWith('.')
    ? STRUCTURED_LOG_EXTENSION.slice(1)
    : STRUCTURED_LOG_EXTENSION;
  const prefix = `${STRUCTURED_LOG_BASENAME}.${date}.`;
  const suffix = `.${ext}`;
  let bestIndex = 1;
  try {
    const entries = readdirSync(logDir);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      if (!entry.endsWith(suffix)) continue;
      const mid = entry.slice(prefix.length, entry.length - suffix.length);
      if (!/^\d+$/.test(mid)) continue;
      const idx = Number(mid);
      if (Number.isFinite(idx) && idx > bestIndex) bestIndex = idx;
    }
  } catch {
    // log directory may not exist yet; fall through to `.1`.
  }
  return join(logDir, `${prefix}${bestIndex.toString()}${STRUCTURED_LOG_EXTENSION}`);
}
