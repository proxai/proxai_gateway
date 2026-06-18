import { statFile } from 'core/io/fs';
import { maxRowid, openReadOnly, pageCount, snapshotSqlite, tableExists } from 'core/io/sqlite';
import { nextGenerationSuffix, requireDefined, sha256Hex } from 'core/utils';
import {
  detectVacuum,
  getCursor,
  getCursorWithFallback,
  getHighestGenerationPath,
  setCursor,
} from 'services/buffer';
import { SUB_AGENT_CAPTURE_BY_SOURCE } from 'services/config/sub-agent-flags';
import { isProjectExcluded } from 'services/exclusion';
import {
  buildCursorGlobalExclusionPlan,
  isCursorGlobalDb,
  resolveCursorWorkspaceFolder,
} from 'sources/cursor/exclusion.ts';
import type { CursorGlobalExclusionPlan } from 'sources/cursor/exclusion.ts';
import {
  CURSOR_DISK_KV_TABLE,
  CURSOR_KEY_PREFIX_AGENT_KV_BLOB,
  CURSOR_KEY_PREFIX_BUBBLE,
  CURSOR_KEY_PREFIX_COMPOSER,
  CURSOR_SOURCE_APP,
} from 'sources/cursor/cursor.constants.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
  DiscoveredCursorFile,
} from 'sources/cursor/cursor.types.ts';
import { extractAgentSchemaVersion } from 'sources/cursor/extract-version.ts';
import { processRows } from 'sources/cursor/process-rows.ts';

export function buildCursorSelectRowsSql(_captureSubAgents: boolean): string {
  const prefixes = [
    CURSOR_KEY_PREFIX_COMPOSER,
    CURSOR_KEY_PREFIX_BUBBLE,
    CURSOR_KEY_PREFIX_AGENT_KV_BLOB,
  ];
  const clauses = prefixes.map((p) => `key LIKE '${p}%'`).join(' OR ');
  return `
  SELECT rowid, key, CAST(value AS TEXT) AS value
  FROM ${CURSOR_DISK_KV_TABLE}
  WHERE rowid > ?
    AND (${clauses})
  ORDER BY rowid ASC
`;
}

const SELECT_ROWS_SQL_BASE = buildCursorSelectRowsSql(false);
const SELECT_ROWS_SQL_WITH_SUB_AGENTS = buildCursorSelectRowsSql(true);

export function selectCursorSql(captureSubAgents: boolean): string {
  return captureSubAgents ? SELECT_ROWS_SQL_WITH_SUB_AGENTS : SELECT_ROWS_SQL_BASE;
}

interface KvRow {
  rowid: number;
  key: string;
  value: string;
}

export async function collectCursorFile(
  file: DiscoveredCursorFile,
  context: CursorCollectorContext,
  captureSubAgents: boolean = SUB_AGENT_CAPTURE_BY_SOURCE.cursor,
): Promise<CursorCollectorResult> {
  const result: CursorCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;

  try {
    snapshot = await snapshotSqlite(file.sourcePath);
    const db = openReadOnly(snapshot.path);

    try {
      if (!tableExists(db, CURSOR_DISK_KV_TABLE)) {
        return result;
      }

      const excluded = context.excludedProjects ?? [];

      // Per-workspace DB: the whole file maps to one folder (sibling workspace.json).
      // PAUSE on exclusion — return without advancing the watermark (backfills on un-exclude).
      if (excluded.length > 0 && !isCursorGlobalDb(file.sourcePath)) {
        const folder = resolveCursorWorkspaceFolder(file.sourcePath);
        if (folder !== null && isProjectExcluded(folder, excluded)) {
          context.logger?.info(
            {
              event: 'capture.project_excluded',
              source_app: CURSOR_SOURCE_APP,
              source_path_hash: file.sourcePathHash,
              project: folder,
            },
            'paused capture for excluded cursor workspace',
          );
          return result; // PAUSE: no setCursor
        }
      }

      let effectiveSourcePath = file.sourcePath;
      try {
        effectiveSourcePath = getHighestGenerationPath(
          context.buffer,
          CURSOR_SOURCE_APP,
          file.sourcePath,
        );
      } catch {}
      let effectiveSourcePathHash = sha256Hex(effectiveSourcePath);
      let priorCursor = getCursorWithFallback(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: effectiveSourcePathHash,
        sourceInode: null,
        watermarkTable: null,
      });

      const currentPageCount = pageCount(db);
      const currentMaxRowid = maxRowid(db, CURSOR_DISK_KV_TABLE);
      const sourceStat = await statFile(file.sourcePath);
      const currentSizeBytes = sourceStat.exists ? sourceStat.size : 0;

      if (priorCursor !== null) {
        const detection = detectVacuum({
          cursorSizeBytes: priorCursor.lastSeenSizeBytes,
          cursorPageCount: priorCursor.lastSeenPageCount,
          cursorWatermarkEnd: priorCursor.watermarkEnd,
          currentSizeBytes,
          currentPageCount,
          currentMaxRowid,
        });
        if (detection.vacuumed) {
          const oldPath = effectiveSourcePath;
          effectiveSourcePath = nextGenerationSuffix(effectiveSourcePath);
          effectiveSourcePathHash = sha256Hex(effectiveSourcePath);
          context.logger?.warn(
            {
              event: 'vacuum.detected',
              source_app: CURSOR_SOURCE_APP,
              reason: detection.reason,
              old_path: oldPath,
              new_path: effectiveSourcePath,
            },
            'sqlite vacuum detected; re-keying source via #gen suffix',
          );
          priorCursor = null;
        }
      }

      const lastMaxRowid = (priorCursor?.watermarkEnd ?? 1) - 1;
      const rows = db.query<KvRow, [number]>(selectCursorSql(captureSubAgents)).all(lastMaxRowid);

      if (rows.length === 0) {
        if (priorCursor !== null) {
          setCursor(context.buffer, {
            sourceApp: CURSOR_SOURCE_APP,
            sourcePathHash: effectiveSourcePathHash,
            sourcePath: effectiveSourcePath,
            sourceInode: null,
            watermarkTable: null,
            watermarkEnd: priorCursor.watermarkEnd,
            lastSeenSizeBytes: currentSizeBytes,
            lastSeenPageCount: currentPageCount,
            consecutiveErrors: 0,
          });
        } else if (effectiveSourcePath !== file.sourcePath) {
          setCursor(context.buffer, {
            sourceApp: CURSOR_SOURCE_APP,
            sourcePathHash: effectiveSourcePathHash,
            sourcePath: effectiveSourcePath,
            sourceInode: null,
            watermarkTable: null,
            watermarkEnd: 0,
            lastSeenSizeBytes: currentSizeBytes,
            lastSeenPageCount: currentPageCount,
            consecutiveErrors: 0,
          });
        }
        return result;
      }

      const kvRows: CursorDiskKvRow[] = rows.map((r) => ({
        rowid: r.rowid,
        key: r.key,
        value: r.value,
      }));

      const agentSchemaVersion = extractAgentSchemaVersion(kvRows);
      const lastRow = requireDefined(rows[rows.length - 1], 'last row');
      const finalWatermarkEnd = lastRow.rowid + 1;

      let exclusionPlan: CursorGlobalExclusionPlan | undefined;
      if (excluded.length > 0 && isCursorGlobalDb(file.sourcePath)) {
        exclusionPlan = buildCursorGlobalExclusionPlan(db, excluded);
      }

      processRows({
        rows: kvRows,
        context,
        agentSchemaVersion,
        effectiveSourcePath,
        effectiveSourcePathHash,
        currentSizeBytes,
        currentPageCount,
        finalWatermarkEnd,
        result,
        ...(exclusionPlan !== undefined && { exclusionPlan }),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    try {
      const priorCursor = getCursor(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: null,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      const priorWatermarkEnd = priorCursor?.watermarkEnd ?? 1;
      setCursor(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: null,
        watermarkTable: null,
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
  } finally {
    if (snapshot !== null) {
      await snapshot.cleanup();
    }
  }

  return result;
}
