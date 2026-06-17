import type { Database } from 'bun:sqlite';

import { maxRowid, tableExists } from 'core/io/sqlite';
import { nextGenerationSuffix, sha256Hex } from 'core/utils';
import { detectVacuum, getCursorWithFallback, getHighestGenerationPath } from 'services/buffer';
import { GEMINI_ALLOWED_TABLES, GEMINI_SOURCE_APP } from 'sources/gemini/gemini.constants.ts';
import type { DiscoveredGeminiFile, GeminiCollectorContext } from 'sources/gemini/gemini.types.ts';

export interface GeminiIdentity {
  sourcePath: string;
  sourcePathHash: string;
  rotated: boolean;
}

export function resolveGeminiIdentity(
  db: Database,
  file: DiscoveredGeminiFile,
  context: GeminiCollectorContext,
  currentSizeBytes: number,
  currentPageCount: number,
): GeminiIdentity {
  let currentPath = file.sourcePath;
  try {
    currentPath = getHighestGenerationPath(context.buffer, GEMINI_SOURCE_APP, file.sourcePath);
  } catch {}
  const currentPathHash = sha256Hex(currentPath);

  for (const table of GEMINI_ALLOWED_TABLES) {
    if (!tableExists(db, table)) continue;
    let cursor;
    try {
      cursor = getCursorWithFallback(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: currentPathHash,
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
      const newPath = nextGenerationSuffix(currentPath);
      context.logger?.warn(
        {
          event: 'vacuum.detected',
          source_app: GEMINI_SOURCE_APP,
          reason: detection.reason,
          old_path: currentPath,
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
    sourcePath: currentPath,
    sourcePathHash: currentPathHash,
    rotated: false,
  };
}
