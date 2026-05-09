import type { Database } from 'bun:sqlite';

import { tableExists } from 'core/io/sqlite';
import {
  generateUuidV7,
  nowIsoUtc,
  OversizedDecompressedSliceError,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import { getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
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
  compressedBytes: number;
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
      });
    }
    return;
  }

  const measureSlice = createSliceMeasurer();
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: context.maxDecompressedBytes,
    measureCompressed: (slice) => measureSlice(slice).compressedBytes,
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

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    if (slice.length === 0) continue;
    const firstRowidInSlice = slice[0]!.rowid;
    const lastRowidInSlice = slice[slice.length - 1]!.rowid;
    const sliceWatermarkEnd = lastRowidInSlice + 1;

    const redactedJson = applyRedaction(JSON.stringify(slice)).redacted;
    const redactedBytes = Buffer.byteLength(redactedJson, 'utf8');
    const compressed = zstdCompressSync(redactedJson);

    if (redactedBytes > BODY_MAX_DECOMPRESSED_BYTES) {
      throw new OversizedDecompressedSliceError({
        sourcePath: identity.sourcePath,
        sourcePathHash: identity.sourcePathHash,
        rawBytes: redactedBytes,
        compressedBytes: compressed.byteLength,
        sliceIndex: i,
        cap: BODY_MAX_DECOMPRESSED_BYTES,
      });
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
  });

  result.capturedBatches += slices.length;
}

function createSliceMeasurer(): (slice: readonly CodexRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly CodexRow[], SliceMeasurement>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedJson = applyRedaction(JSON.stringify(slice)).redacted;
      const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
      const compressedBytes = zstdCompressSync(redactedJson).byteLength;
      entry = { redactedJson, rawBytes, compressedBytes };
      cache.set(slice, entry);
    }
    return entry;
  };
}
