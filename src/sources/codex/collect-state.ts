import type { Database } from 'bun:sqlite';

import { statFile } from 'core/io/fs';
import { maxRowid, openReadOnly, pageCount, snapshotSqlite, tableExists } from 'core/io/sqlite';
import {
  generateUuidV7,
  nextGenerationSuffix,
  nowIsoUtc,
  sha256Hex,
  zstdCompressSync,
} from 'core/utils';
import { detectVacuum, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import type { CodexTable } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CODEX_ALLOWED_STATE_TABLES,
  CODEX_BODY_COMPRESSION,
  CODEX_DEFAULT_AGENT_SCHEMA_VERSION,
  CODEX_SOURCE_APP,
  CODEX_STATE_BODY_FORMAT,
  CODEX_STATE_SOURCE_KIND,
  CODEX_THREADS_TABLE,
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  CodexStateCollectorResult,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';

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

      // Vacuum is a file-level event in SQLite — when detected against ANY of
      // the codex tables, all tables in the file have rotated together. We
      // resolve the new source identity once up front so per-table cursors
      // all migrate atomically.
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
  } finally {
    if (snapshot !== null) {
      await snapshot.cleanup();
    }
  }

  return { agentSchemaVersion, result };
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
      >(`SELECT cli_version FROM "${CODEX_THREADS_TABLE}" ORDER BY rowid DESC LIMIT 1`)
      .get();
    if (row !== null && typeof row.cli_version === 'string' && row.cli_version.length > 0) {
      return row.cli_version;
    }
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  } catch {
    return CODEX_DEFAULT_AGENT_SCHEMA_VERSION;
  }
}

interface SourceIdentity {
  sourcePath: string;
  sourcePathHash: string;
  rotated: boolean;
}

/**
 * Decides whether to keep the discovered (path, hash) or re-key under a fresh
 * `#gen=N` suffix. Inspects every codex table's existing cursor for vacuum
 * signals (size, page_count, rowid regression); the FIRST positive signal
 * across any table forces the whole file to rotate.
 */
function resolveSourceIdentity(
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
      // Buffer DB unreachable. Skip vacuum detection here; the per-table loop
      // will hit the same error and surface it as a table-scoped error.
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

function collectOneTable(
  db: Database,
  file: DiscoveredCodexStateFile,
  context: CodexCollectorContext,
  table: CodexTable,
  agentSchemaVersion: string,
  result: CodexCollectorResult,
  identity: SourceIdentity,
  currentSizeBytes: number,
  currentPageCount: number,
): void {
  if (!tableExists(db, table)) return;

  // After rotation, treat per-table cursor as absent — we want fresh
  // watermark=0 under the new source identity. Before rotation, look up the
  // existing cursor under the stable hash.
  const priorCursor = identity.rotated
    ? null
    : getCursorWithFallback(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: null,
        watermarkTable: table,
      });
  const lastMaxRowid = (priorCursor?.watermarkEnd ?? 1) - 1;

  const escaped = table.replace(/"/g, '""');
  const rows = db
    .query<
      Record<string, unknown> & { rowid: number },
      [number]
    >(`SELECT rowid, * FROM "${escaped}" WHERE rowid > ? ORDER BY rowid ASC`)
    .all(lastMaxRowid);
  if (rows.length === 0) {
    // No new rows under this (effective) identity. Refresh size/page_count on
    // the existing cursor row so vacuum stays detectable next poll. We skip
    // this when no prior cursor existed and we haven't rotated — creating an
    // empty watermark=0 row on first contact would muddle the "first poll"
    // semantics other code relies on.
    if (priorCursor !== null) {
      setCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourcePath: identity.sourcePath,
        sourceInode: null,
        watermarkTable: table,
        watermarkEnd: priorCursor.watermarkEnd,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
      });
    }
    return;
  }

  const jsonString = JSON.stringify(rows);
  const redaction = applyRedaction(jsonString);
  const compressed = zstdCompressSync(redaction.redacted);

  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;
  const watermarkStart = firstRow.rowid;
  const watermarkEnd = lastRow.rowid + 1;

  const batch: NewBatch = {
    captureId: generateUuidV7(),
    sourceApp: CODEX_SOURCE_APP,
    sourceKind: CODEX_STATE_SOURCE_KIND,
    sourcePath: identity.sourcePath,
    sourcePathHash: identity.sourcePathHash,
    sourceInode: null,
    watermarkKind: 'rowid_range',
    watermarkStart,
    watermarkEnd,
    watermarkTable: table,
    agentSchemaVersion,
    gatewayVersion: context.gatewayVersion,
    capturedAtUtc: nowIsoUtc(),
    bodyFormat: CODEX_STATE_BODY_FORMAT,
    bodyCompression: CODEX_BODY_COMPRESSION,
    body: compressed,
  };

  insertBatch(context.buffer, batch);

  setCursor(context.buffer, {
    sourceApp: CODEX_SOURCE_APP,
    sourcePathHash: identity.sourcePathHash,
    sourcePath: identity.sourcePath,
    sourceInode: null,
    watermarkTable: table,
    watermarkEnd,
    lastSeenSizeBytes: currentSizeBytes,
    lastSeenPageCount: currentPageCount,
  });

  result.capturedBatches += 1;
  result.capturedBytes += compressed.byteLength;
}
