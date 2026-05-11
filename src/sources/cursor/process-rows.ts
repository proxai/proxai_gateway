import { generateUuidV7, nowIsoUtc, splitRowsByCompressedSize, zstdCompressSync } from 'core/utils';
import { getCursor, insertBatch, recordQuarantine, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CURSOR_BODY_COMPRESSION,
  CURSOR_BODY_FORMAT,
  CURSOR_SOURCE_APP,
  CURSOR_SOURCE_KIND,
} from 'sources/cursor/cursor.constants.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
} from 'sources/cursor/cursor.types.ts';

interface SliceMeasurement {
  redactedJson: string;
  rawBytes: number;
  compressedBytes: number;
}

export interface ProcessRowsInput {
  rows: CursorDiskKvRow[];
  context: CursorCollectorContext;
  agentSchemaVersion: string;
  effectiveSourcePath: string;
  effectiveSourcePathHash: string;
  currentSizeBytes: number;
  currentPageCount: number;
  finalWatermarkEnd: number;
  result: CursorCollectorResult;
}

export function processRows(input: ProcessRowsInput): void {
  const measureSlice = createSliceMeasurer();
  const slices = splitRowsByCompressedSize(input.rows, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: input.context.maxDecompressedBytes,
    measureCompressed: (slice) => measureSlice(slice).compressedBytes,
    measureUncompressed: (slice) => measureSlice(slice).rawBytes,
  });

  if (slices.length > 1) {
    input.context.logger?.info(
      {
        event: 'capture.split_for_size',
        source_app: CURSOR_SOURCE_APP,
        source_path_hash: input.effectiveSourcePathHash,
        total_slices: slices.length,
        row_count: input.rows.length,
      },
      'oversized capture slice split into multiple batches',
    );
  }

  let quarantinedCount = 0;
  let acceptedSlices = 0;
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    if (slice.length === 0) continue;
    const firstRowidInSlice = slice[0]!.rowid;
    const lastRowidInSlice = slice[slice.length - 1]!.rowid;
    const sliceWatermarkEnd = lastRowidInSlice + 1;

    const redactedJson = applyRedaction(JSON.stringify({ rows: slice })).redacted;
    const redactedBytes = Buffer.byteLength(redactedJson, 'utf8');
    const compressed = zstdCompressSync(redactedJson);

    if (redactedBytes > BODY_MAX_DECOMPRESSED_BYTES) {
      try {
        recordQuarantine(input.context.buffer, {
          sourceApp: CURSOR_SOURCE_APP,
          sourcePath: input.effectiveSourcePath,
          sourcePathHash: input.effectiveSourcePathHash,
          sourceInode: null,
          watermarkTable: null,
          watermarkPosition: lastRowidInSlice,
          rowPk: lastRowidInSlice.toString(),
          redactedSizeBytes: redactedBytes,
          reason: 'oversized_decompressed',
          quarantinedAtUtc: nowIsoUtc(),
          gatewayVersion: input.context.gatewayVersion,
        });
      } catch (qerr) {
        input.context.logger?.warn(
          {
            event: 'quarantine.write_failed',
            source_app: CURSOR_SOURCE_APP,
            source_path_hash: input.effectiveSourcePathHash,
            error: qerr instanceof Error ? qerr.message : String(qerr),
          },
          'failed to record oversized row quarantine',
        );
      }
      input.context.logger?.warn(
        {
          event: 'oversized_row.quarantined',
          source_app: CURSOR_SOURCE_APP,
          source_path_hash: input.effectiveSourcePathHash,
          watermark_position: lastRowidInSlice,
          redacted_size_bytes: redactedBytes,
          cap: BODY_MAX_DECOMPRESSED_BYTES,
        },
        'oversized cursor kv row quarantined; advancing cursor past it',
      );
      input.result.errors.push({
        sourcePath: input.effectiveSourcePath,
        reason: `decompressed slice exceeded ${BODY_MAX_DECOMPRESSED_BYTES.toString()} bytes (${redactedBytes.toString()}); row quarantined`,
      });
      const priorCursor = getCursor(input.context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: input.effectiveSourcePathHash,
        sourceInode: null,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      setCursor(input.context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: input.effectiveSourcePathHash,
        sourcePath: input.effectiveSourcePath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd: sliceWatermarkEnd,
        consecutiveErrors: priorErrors + 1,
        lastSeenSizeBytes: input.currentSizeBytes,
        lastSeenPageCount: input.currentPageCount,
      });
      quarantinedCount += 1;
      continue;
    }

    if (slices.length > 1) {
      input.context.logger?.debug(
        {
          event: 'capture.chunked',
          source_app: CURSOR_SOURCE_APP,
          source_path_hash: input.effectiveSourcePathHash,
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
      sourcePath: input.effectiveSourcePath,
      sourcePathHash: input.effectiveSourcePathHash,
      sourceInode: null,
      watermarkKind: 'rowid_range',
      watermarkStart: firstRowidInSlice,
      watermarkEnd: sliceWatermarkEnd,
      watermarkTable: null,
      agentSchemaVersion: input.agentSchemaVersion,
      gatewayVersion: input.context.gatewayVersion,
      capturedAtUtc: nowIsoUtc(),
      bodyFormat: CURSOR_BODY_FORMAT,
      bodyCompression: CURSOR_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(input.context.buffer, batch);
    input.result.capturedBytes += compressed.byteLength;
    acceptedSlices += 1;
  }

  let finalConsecutiveErrors = 0;
  if (quarantinedCount > 0) {
    const refreshed = getCursor(input.context.buffer, {
      sourceApp: CURSOR_SOURCE_APP,
      sourcePathHash: input.effectiveSourcePathHash,
      sourceInode: null,
      watermarkTable: null,
    });
    finalConsecutiveErrors = refreshed?.consecutiveErrors ?? quarantinedCount;
  }
  setCursor(input.context.buffer, {
    sourceApp: CURSOR_SOURCE_APP,
    sourcePathHash: input.effectiveSourcePathHash,
    sourcePath: input.effectiveSourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: input.finalWatermarkEnd,
    lastSeenSizeBytes: input.currentSizeBytes,
    lastSeenPageCount: input.currentPageCount,
    consecutiveErrors: finalConsecutiveErrors,
  });

  input.result.capturedBatches += acceptedSlices;
}

function createSliceMeasurer(): (slice: readonly CursorDiskKvRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly CursorDiskKvRow[], SliceMeasurement>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedJson = applyRedaction(JSON.stringify({ rows: slice })).redacted;
      const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
      const compressedBytes = zstdCompressSync(redactedJson).byteLength;
      entry = { redactedJson, rawBytes, compressedBytes };
      cache.set(slice, entry);
    }
    return entry;
  };
}
