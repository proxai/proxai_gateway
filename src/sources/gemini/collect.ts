import type { Database } from 'bun:sqlite';

import { statFile } from 'core/io/fs';
import { openReadOnly, pageCount, snapshotSqlite } from 'core/io/sqlite';
import { getCursor, setCursor } from 'services/buffer';
import {
  GEMINI_ALLOWED_TABLES,
  GEMINI_DEFAULT_AGENT_SCHEMA_VERSION,
  GEMINI_SOURCE_APP,
} from 'sources/gemini/gemini.constants.ts';
import type {
  DiscoveredGeminiFile,
  GeminiCollectorContext,
  GeminiCollectorResult,
} from 'sources/gemini/gemini.types.ts';
import { collectOneGeminiTable } from 'sources/gemini/process-rows.ts';
import { resolveGeminiIdentity } from 'sources/gemini/resolve-identity.ts';

export async function collectGeminiConversation(
  file: DiscoveredGeminiFile,
  context: GeminiCollectorContext,
): Promise<GeminiCollectorResult> {
  const result: GeminiCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;

  try {
    snapshot = await snapshotSqlite(file.sourcePath);
    const db = openReadOnly(snapshot.path);

    try {
      const sourceStat = await statFile(file.sourcePath);
      const currentSizeBytes = sourceStat.exists ? sourceStat.size : 0;
      const currentPageCount = pageCount(db);

      const identity = resolveGeminiIdentity(db, file, context, currentSizeBytes, currentPageCount);

      for (const table of GEMINI_ALLOWED_TABLES) {
        try {
          collectOneGeminiTable(
            db,
            file,
            context,
            table,
            GEMINI_DEFAULT_AGENT_SCHEMA_VERSION,
            result,
            identity,
            currentSizeBytes,
            currentPageCount,
          );
        } catch (err) {
          result.errors.push({
            sourcePath: file.sourcePath,
            reason: err instanceof Error ? err.message : String(err),
            table,
          });
          bumpConsecutiveErrors(
            context.buffer,
            { sourcePath: identity.sourcePath, sourcePathHash: identity.sourcePathHash },
            table,
          );
        }
      }
    } finally {
      db.close();
    }
    clearFileLevelError(context.buffer, file);
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    bumpConsecutiveErrors(
      context.buffer,
      { sourcePath: file.sourcePath, sourcePathHash: file.sourcePathHash },
      null,
    );
  } finally {
    if (snapshot !== null) {
      await snapshot.cleanup();
    }
  }

  return result;
}

function bumpConsecutiveErrors(
  db: Database,
  identity: { sourcePath: string; sourcePathHash: string },
  table: string | null,
): void {
  try {
    const priorCursor = getCursor(db, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
    });
    const priorErrors = priorCursor?.consecutiveErrors ?? 0;
    const priorWatermarkEnd = priorCursor?.watermarkEnd ?? 0;
    setCursor(db, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: identity.sourcePathHash,
      sourcePath: identity.sourcePath,
      sourceInode: null,
      watermarkTable: table,
      watermarkEnd: priorWatermarkEnd,
      consecutiveErrors: priorErrors + 1,
      ...(priorCursor?.lastSeenSizeBytes !== null && priorCursor?.lastSeenSizeBytes !== undefined
        ? { lastSeenSizeBytes: priorCursor.lastSeenSizeBytes }
        : {}),
      ...(priorCursor?.lastSeenPageCount !== null && priorCursor?.lastSeenPageCount !== undefined
        ? { lastSeenPageCount: priorCursor.lastSeenPageCount }
        : {}),
    });
  } catch {}
}

function clearFileLevelError(db: Database, file: DiscoveredGeminiFile): void {
  try {
    const priorCursor = getCursor(db, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourceInode: null,
      watermarkTable: null,
    });
    if (priorCursor === null || priorCursor.consecutiveErrors === 0) return;
    setCursor(db, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: null,
      watermarkTable: null,
      watermarkEnd: priorCursor.watermarkEnd,
      consecutiveErrors: 0,
    });
  } catch {}
}
