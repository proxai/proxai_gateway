import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import { setCursor } from 'services/buffer';
import type { HttpClient, ServerWatermark } from 'services/http';

export interface SyncWatermarksDeps {
  buffer: Database;
  http: HttpClient;
  logger?: Logger;
}

export interface SyncWatermarksResult {
  fetched: number;
  applied: number;
  skipped: number;
}

export async function syncServerWatermarks(
  deps: SyncWatermarksDeps,
): Promise<SyncWatermarksResult> {
  const { buffer, http, logger } = deps;
  const response = await http.fetchWatermarks();

  const result: SyncWatermarksResult = {
    fetched: response.watermarks.length,
    applied: 0,
    skipped: 0,
  };

  for (const w of response.watermarks) {
    if (!isApplicable(w)) {
      result.skipped++;
      logger?.debug(
        {
          event: 'watermark_sync.skip',
          source_app: w.sourceApp,
          source_path_hash: w.sourcePathHash,
          watermark_table: w.watermarkTable,
        },
        'skipping non-applicable server watermark',
      );
      continue;
    }
    setCursor(buffer, {
      sourceApp: w.sourceApp as 'claude-code' | 'cursor' | 'codex',
      sourcePathHash: w.sourcePathHash,
      sourcePath: '',
      sourceInode: null,
      watermarkTable: w.watermarkTable,
      watermarkEnd: w.watermarkEnd,
    });
    result.applied++;
  }

  return result;
}

const KNOWN_APPS = new Set<string>(['claude-code', 'cursor', 'codex']);

function isApplicable(w: ServerWatermark): boolean {
  if (!KNOWN_APPS.has(w.sourceApp)) return false;
  if (typeof w.sourcePathHash !== 'string' || w.sourcePathHash.length === 0) return false;
  if (typeof w.watermarkEnd !== 'number' || !Number.isFinite(w.watermarkEnd)) return false;
  return true;
}
