import type { Database } from 'bun:sqlite';

import { tableExists } from 'core/io/sqlite';
import { generateUuidV7, nowIsoUtc, splitRowsByCompressedSize, zstdCompressSync } from 'core/utils';
import {
  getCursor,
  getCursorWithFallback,
  insertBatch,
  recordQuarantine,
  setCursor,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import type { CodexTable } from 'services/contract';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CODEX_BODY_COMPRESSION,
  CODEX_SOURCE_APP,
  CODEX_STATE_BODY_FORMAT,
  CODEX_STATE_SOURCE_KIND,
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';
import type { SourceIdentity } from 'sources/codex/resolve-state-identity.ts';

type CodexRow = Record<string, unknown> & { rowid: number };

interface SliceMeasurement {
  redactedJson: string;
  rawBytes: number;
  compressed: Uint8Array;
}

export function collectOneTable(
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
      CodexRow,
      [number]
    >(`SELECT rowid, * FROM "${escaped}" WHERE rowid > ? ORDER BY rowid ASC`)
    .all(lastMaxRowid);
  if (rows.length === 0) {
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
        consecutiveErrors: 0,
      });
    }
    return;
  }

  const measureSlice = createSliceMeasurer();
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: context.maxDecompressedBytes,
    measureCompressed: (slice) => measureSlice(slice).compressed.byteLength,
    measureUncompressed: (slice) => measureSlice(slice).rawBytes,
  });

  if (slices.length > 1) {
    context.logger?.info(
      {
        event: 'capture.split_for_size',
        source_app: CODEX_SOURCE_APP,
        source_path_hash: identity.sourcePathHash,
        watermark_table: table,
        total_slices: slices.length,
        row_count: rows.length,
      },
      'oversized capture slice split into multiple batches',
    );
  }

  const lastRow = rows[rows.length - 1]!;
  const finalWatermarkEnd = lastRow.rowid + 1;

  let quarantinedCount = 0;
  let acceptedSlices = 0;
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    if (slice.length === 0) continue;
    const firstRowidInSlice = slice[0]!.rowid;
    const lastRowidInSlice = slice[slice.length - 1]!.rowid;
    const sliceWatermarkEnd = lastRowidInSlice + 1;

    const measurement = measureSlice(slice);
    const redactedBytes = measurement.rawBytes;
    const compressed = measurement.compressed;

    if (redactedBytes > BODY_MAX_DECOMPRESSED_BYTES) {
      try {
        recordQuarantine(context.buffer, {
          sourceApp: CODEX_SOURCE_APP,
          sourcePath: identity.sourcePath,
          sourcePathHash: identity.sourcePathHash,
          sourceInode: null,
          watermarkTable: table,
          watermarkPosition: lastRowidInSlice,
          rowPk: lastRowidInSlice.toString(),
          redactedSizeBytes: redactedBytes,
          reason: 'oversized_decompressed',
          quarantinedAtUtc: nowIsoUtc(),
          gatewayVersion: context.gatewayVersion,
        });
      } catch (qerr) {
        context.logger?.warn(
          {
            event: 'quarantine.write_failed',
            source_app: CODEX_SOURCE_APP,
            source_path_hash: identity.sourcePathHash,
            error: qerr instanceof Error ? qerr.message : String(qerr),
          },
          'failed to record oversized row quarantine',
        );
      }
      context.logger?.warn(
        {
          event: 'oversized_row.quarantined',
          source_app: CODEX_SOURCE_APP,
          source_path_hash: identity.sourcePathHash,
          watermark_table: table,
          watermark_position: lastRowidInSlice,
          redacted_size_bytes: redactedBytes,
          cap: BODY_MAX_DECOMPRESSED_BYTES,
        },
        'oversized codex state row quarantined; advancing cursor past it',
      );
      result.errors.push({
        sourcePath: identity.sourcePath,
        reason: `decompressed slice exceeded ${BODY_MAX_DECOMPRESSED_BYTES.toString()} bytes (${redactedBytes.toString()}); row quarantined`,
        table,
      });
      const refreshedCursor = getCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourceInode: null,
        watermarkTable: table,
      });
      const priorErrors = refreshedCursor?.consecutiveErrors ?? 0;
      setCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourcePath: identity.sourcePath,
        sourceInode: null,
        watermarkTable: table,
        watermarkEnd: sliceWatermarkEnd,
        consecutiveErrors: priorErrors + 1,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
      });
      quarantinedCount += 1;
      continue;
    }

    if (slices.length > 1) {
      context.logger?.debug(
        {
          event: 'capture.chunked',
          source_app: CODEX_SOURCE_APP,
          source_path_hash: identity.sourcePathHash,
          watermark_table: table,
          slice_index: i,
          total_slices: slices.length,
          compressed_bytes: compressed.byteLength,
        },
        'capture chunk insert',
      );
    }

    const batch: NewBatch = {
      captureId: generateUuidV7(),
      sourceApp: CODEX_SOURCE_APP,
      sourceKind: CODEX_STATE_SOURCE_KIND,
      sourcePath: identity.sourcePath,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkKind: 'rowid_range',
      watermarkStart: firstRowidInSlice,
      watermarkEnd: sliceWatermarkEnd,
      watermarkTable: table,
      agentSchemaVersion,
      gatewayVersion: context.gatewayVersion,
      capturedAtUtc: nowIsoUtc(),
      bodyFormat: CODEX_STATE_BODY_FORMAT,
      bodyCompression: CODEX_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(context.buffer, batch);
    result.capturedBytes += compressed.byteLength;
    acceptedSlices += 1;
  }

  let finalConsecutiveErrors = 0;
  if (quarantinedCount > 0) {
    const refreshed = getCursor(context.buffer, {
      sourceApp: CODEX_SOURCE_APP,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
    });
    finalConsecutiveErrors = refreshed?.consecutiveErrors ?? quarantinedCount;
  }
  setCursor(context.buffer, {
    sourceApp: CODEX_SOURCE_APP,
    sourcePathHash: identity.sourcePathHash,
    sourcePath: identity.sourcePath,
    sourceInode: null,
    watermarkTable: table,
    watermarkEnd: finalWatermarkEnd,
    lastSeenSizeBytes: currentSizeBytes,
    lastSeenPageCount: currentPageCount,
    consecutiveErrors: finalConsecutiveErrors,
  });

  result.capturedBatches += acceptedSlices;
}

function createSliceMeasurer(): (slice: readonly CodexRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly CodexRow[], SliceMeasurement>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedJson = applyRedaction(JSON.stringify(slice)).redacted;
      const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
      const compressed = zstdCompressSync(redactedJson);
      entry = { redactedJson, rawBytes, compressed };
      cache.set(slice, entry);
    }
    return entry;
  };
}
