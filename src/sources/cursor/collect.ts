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
import { applyRedaction } from 'services/redaction';
import {
  CURSOR_BODY_COMPRESSION,
  CURSOR_BODY_FORMAT,
  CURSOR_DEFAULT_AGENT_SCHEMA_VERSION,
  CURSOR_DISK_KV_TABLE,
  CURSOR_KEY_PREFIX_BUBBLE,
  CURSOR_KEY_PREFIX_COMPOSER,
  CURSOR_SOURCE_APP,
  CURSOR_SOURCE_KIND,
} from 'sources/cursor/cursor.constants.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
  DiscoveredCursorFile,
} from 'sources/cursor/cursor.types.ts';

const SELECT_ROWS_SQL = `
  SELECT rowid, key, value
  FROM ${CURSOR_DISK_KV_TABLE}
  WHERE rowid > ?
    AND (key LIKE '${CURSOR_KEY_PREFIX_COMPOSER}%' OR key LIKE '${CURSOR_KEY_PREFIX_BUBBLE}%')
  ORDER BY rowid ASC
`;

interface KvRow {
  rowid: number;
  key: string;
  value: string;
}

export async function collectCursorFile(
  file: DiscoveredCursorFile,
  context: CursorCollectorContext,
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

      // Resolve effective source identity. If the previous cursor for this
      // path indicates the source DB rotated (size shrank, page_count fell,
      // or rowids regressed beneath our saved watermark), bump the #gen=N
      // suffix so the server treats this as a fresh stream and our local
      // cursor restarts at watermark 0.
      let effectiveSourcePath = file.sourcePath;
      let effectiveSourcePathHash = file.sourcePathHash;
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
          // Old cursor row is left frozen; capture under the new identity
          // restarts at watermark 0.
          priorCursor = null;
        }
      }

      const lastMaxRowid = (priorCursor?.watermarkEnd ?? 1) - 1;
      const rows = db.query<KvRow, [number]>(SELECT_ROWS_SQL).all(lastMaxRowid);

      if (rows.length === 0) {
        // No new rows; still persist the latest size/page_count under the
        // current cursor identity so we can detect vacuum next time. We only
        // do this when a prior cursor already existed — otherwise we'd
        // create an empty cursor row with watermark_end = 0, which would
        // confuse downstream consumers that treat cursor existence as
        // evidence of progress.
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
          });
        }
        return result;
      }

      const kvRows: CursorDiskKvRow[] = rows.map((r) => ({
        rowid: r.rowid,
        key: r.key,
        value: r.value,
      }));

      const jsonString = JSON.stringify(kvRows);
      const redaction = applyRedaction(jsonString);
      const agentSchemaVersion = extractAgentSchemaVersion(kvRows);
      const compressed = zstdCompressSync(redaction.redacted);

      const firstRow = rows[0]!;
      const lastRow = rows[rows.length - 1]!;
      const watermarkStart = firstRow.rowid;
      const watermarkEnd = lastRow.rowid + 1;

      const batch: NewBatch = {
        captureId: generateUuidV7(),
        sourceApp: CURSOR_SOURCE_APP,
        sourceKind: CURSOR_SOURCE_KIND,
        sourcePath: effectiveSourcePath,
        sourcePathHash: effectiveSourcePathHash,
        sourceInode: null,
        watermarkKind: 'rowid_range',
        watermarkStart,
        watermarkEnd,
        watermarkTable: null,
        agentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CURSOR_BODY_FORMAT,
        bodyCompression: CURSOR_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);

      setCursor(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: effectiveSourcePathHash,
        sourcePath: effectiveSourcePath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
      });

      result.capturedBatches = 1;
      result.capturedBytes = compressed.byteLength;
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

  return result;
}

function extractAgentSchemaVersion(rows: CursorDiskKvRow[]): string {
  let composerVersion: string | null = null;
  let bubbleVersion: string | null = null;

  for (const row of rows) {
    if (composerVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_COMPOSER)) {
      composerVersion = parseInnerVersion(row.value);
    }
    if (bubbleVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_BUBBLE)) {
      bubbleVersion = parseInnerVersion(row.value);
    }
    if (composerVersion !== null && bubbleVersion !== null) break;
  }

  if (composerVersion === null && bubbleVersion === null) {
    return CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  return `${composerVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}:${bubbleVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}`;
}

function parseInnerVersion(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const v = parsed['_v'];
    if (typeof v === 'number' || typeof v === 'string') {
      return String(v);
    }
    return null;
  } catch {
    return null;
  }
}
