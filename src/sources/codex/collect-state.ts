import type { Database } from 'bun:sqlite';

import { statFile } from 'core/io/fs';
import { openReadOnly, pageCount, snapshotSqlite, tableExists } from 'core/io/sqlite';
import { getCursor, setCursor } from 'services/buffer';
import {
  CODEX_ALLOWED_STATE_TABLES,
  CODEX_DEFAULT_AGENT_SCHEMA_VERSION,
  CODEX_SOURCE_APP,
  CODEX_THREADS_TABLE,
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  CodexStateCollectorResult,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';
import { collectOneTable } from 'sources/codex/collect-state-table.ts';
import { resolveSourceIdentity } from 'sources/codex/resolve-state-identity.ts';

export async function collectCodexState(
  file: DiscoveredCodexStateFile,
  context: CodexCollectorContext,
): Promise<CodexStateCollectorResult> {
  const result: CodexCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;
  let agentSchemaVersion = CODEX_DEFAULT_AGENT_SCHEMA_VERSION;

  try {
    snapshot = await snapshotSqlite(file.sourcePath);
    const db = openReadOnly(snapshot.path);

    try {
      agentSchemaVersion = sampleCliVersion(db);

      const sourceStat = await statFile(file.sourcePath);
      const currentSizeBytes = sourceStat.exists ? sourceStat.size : 0;
      const currentPageCount = pageCount(db);

      const identity = resolveSourceIdentity(db, file, context, currentSizeBytes, currentPageCount);

      for (const table of CODEX_ALLOWED_STATE_TABLES) {
        try {
          collectOneTable(
            db,
            file,
            context,
            table,
            agentSchemaVersion,
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
          bumpConsecutiveErrors(context.buffer, identity, table);
        }
      }
    } finally {
      db.close();
    }
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

  return { agentSchemaVersion, result };
}

function bumpConsecutiveErrors(
  db: Database,
  identity: { sourcePath: string; sourcePathHash: string },
  table: string | null,
): void {
  try {
    const priorCursor = getCursor(db, {
      sourceApp: CODEX_SOURCE_APP,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
    });
    const priorErrors = priorCursor?.consecutiveErrors ?? 0;
    const priorWatermarkEnd = priorCursor?.watermarkEnd ?? (table === null ? 0 : 1);
    setCursor(db, {
      sourceApp: CODEX_SOURCE_APP,
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
  } catch {
    // best-effort error-counter bump; persistence failures are non-fatal
  }
}

function sampleCliVersion(db: Database): string {
  if (!tableExists(db, CODEX_THREADS_TABLE)) {
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  try {
    const row = db
      .query<
        { cli_version: string | null },
        []
      >(`SELECT cli_version FROM "${CODEX_THREADS_TABLE}" WHERE cli_version != '' ORDER BY rowid DESC LIMIT 1`)
      .get();
    if (row !== null && typeof row.cli_version === 'string' && row.cli_version.length > 0) {
      return row.cli_version;
    }
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  } catch {
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  }
}
