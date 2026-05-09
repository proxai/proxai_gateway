import type { Database } from 'bun:sqlite';

import { maxRowid, tableExists } from 'core/io/sqlite';
import { nextGenerationSuffix, sha256Hex } from 'core/utils';
import { detectVacuum, getCursorWithFallback } from 'services/buffer';
import { CODEX_ALLOWED_STATE_TABLES, CODEX_SOURCE_APP } from 'sources/codex/codex.constants.ts';
import type { CodexCollectorContext, DiscoveredCodexStateFile } from 'sources/codex/codex.types.ts';

export interface SourceIdentity {
  sourcePath: string;
  sourcePathHash: string;
  rotated: boolean;
}

export function resolveSourceIdentity(
  db: Database,
  file: DiscoveredCodexStateFile,
  context: CodexCollectorContext,
  currentSizeBytes: number,
  currentPageCount: number,
): SourceIdentity {
  for (const table of CODEX_ALLOWED_STATE_TABLES) {
    if (!tableExists(db, table)) continue;
    let cursor;
    try {
      cursor = getCursorWithFallback(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: null,
        watermarkTable: table,
      });
    } catch {
      continue;
    }
    if (cursor === null) continue;
    const detection = detectVacuum({
      cursorSizeBytes: cursor.lastSeenSizeBytes,
      cursorPageCount: cursor.lastSeenPageCount,
      cursorWatermarkEnd: cursor.watermarkEnd,
      currentSizeBytes,
      currentPageCount,
      currentMaxRowid: maxRowid(db, table),
    });
    if (detection.vacuumed) {
      const newPath = nextGenerationSuffix(file.sourcePath);
      context.logger?.warn(
        {
          event: 'vacuum.detected',
          source_app: CODEX_SOURCE_APP,
          reason: detection.reason,
          old_path: file.sourcePath,
          new_path: newPath,
          triggering_table: table,
        },
        'sqlite vacuum detected; re-keying source via #gen suffix',
      );
      return {
        sourcePath: newPath,
        sourcePathHash: sha256Hex(newPath),
        rotated: true,
      };
    }
  }
  return {
    sourcePath: file.sourcePath,
    sourcePathHash: file.sourcePathHash,
    rotated: false,
  };
}
