import { statFile } from 'core/io/fs';
import { maxRowid, openReadOnly, pageCount, snapshotSqlite, tableExists } from 'core/io/sqlite';
import {
  generateUuidV7,
  nextGenerationSuffix,
  nowIsoUtc,
  sha256Hex,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import { detectVacuum, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
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
          
          
          priorCursor = null;
        }
      }

      const lastMaxRowid = (priorCursor?.watermarkEnd ?? 1) - 1;
      const rows = db.query<KvRow, [number]>(SELECT_ROWS_SQL).all(lastMaxRowid);

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

      
      
      
      const measureCompressed = (slice: readonly CursorDiskKvRow[]): number =>
        zstdCompressSync(applyRedaction(JSON.stringify(slice)).redacted).byteLength;

      const slices = splitRowsByCompressedSize(kvRows, {
        targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
        measureCompressed,
      });

      if (slices.length > 1) {
        context.logger?.info(
          {
            event: 'capture.split_for_size',
            source_app: CURSOR_SOURCE_APP,
            source_path_hash: effectiveSourcePathHash,
            total_slices: slices.length,
            row_count: kvRows.length,
          },
          'oversized capture slice split into multiple batches',
        );
      }

      const lastRow = rows[rows.length - 1]!;
      const finalWatermarkEnd = lastRow.rowid + 1;

      
      
      
      
      for (let i = 0; i < slices.length; i++) {
        const slice = slices[i]!;
        if (slice.length === 0) continue;
        const firstRowidInSlice = slice[0]!.rowid;
        const lastRowidInSlice = slice[slice.length - 1]!.rowid;
        const sliceWatermarkEnd = lastRowidInSlice + 1;

        const compressed = zstdCompressSync(applyRedaction(JSON.stringify(slice)).redacted);

        if (slices.length > 1) {
          context.logger?.debug(
            {
              event: 'capture.chunked',
              source_app: CURSOR_SOURCE_APP,
              source_path_hash: effectiveSourcePathHash,
              slice_index: i,
              total_slices: slices.length,
              compressed_bytes: compressed.byteLength,
            },
            'capture chunk insert',
          );
        }

        const batch: NewBatch = {
          captureId: generateUuidV7(),
          sourceApp: CURSOR_SOURCE_APP,
          sourceKind: CURSOR_SOURCE_KIND,
          sourcePath: effectiveSourcePath,
          sourcePathHash: effectiveSourcePathHash,
          sourceInode: null,
          watermarkKind: 'rowid_range',
          watermarkStart: firstRowidInSlice,
          watermarkEnd: sliceWatermarkEnd,
          watermarkTable: null,
          agentSchemaVersion,
          gatewayVersion: context.gatewayVersion,
          capturedAtUtc: nowIsoUtc(),
          bodyFormat: CURSOR_BODY_FORMAT,
          bodyCompression: CURSOR_BODY_COMPRESSION,
          body: compressed,
        };

        insertBatch(context.buffer, batch);
        result.capturedBytes += compressed.byteLength;
      }

      setCursor(context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: effectiveSourcePathHash,
        sourcePath: effectiveSourcePath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd: finalWatermarkEnd,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
      });

      result.capturedBatches = slices.length;
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
