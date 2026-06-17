import type { Database } from 'bun:sqlite';

import { tableExists } from 'core/io/sqlite';
import {
  generateUuidV7,
  nowIsoUtc,
  requireDefined,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import {
  getCursor,
  getCursorWithFallback,
  insertBatch,
  recordQuarantine,
  setCursor,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import type { GeminiTable } from 'services/contract';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  GEMINI_ALLOWED_TABLES,
  GEMINI_BODY_COMPRESSION,
  GEMINI_BODY_FORMAT,
  GEMINI_SOURCE_APP,
  GEMINI_SOURCE_KIND,
  GEMINI_STEPS_TABLE,
  GEMINI_TRAJECTORY_META_TABLE,
} from 'sources/gemini/gemini.constants.ts';
import type {
  DiscoveredGeminiFile,
  GeminiCollectorContext,
  GeminiCollectorResult,
  GeminiRowObject,
} from 'sources/gemini/gemini.types.ts';
import type { GeminiIdentity } from 'sources/gemini/resolve-identity.ts';
import {
  decodeStepRow,
  decodeTrajectoryMetadataBlobRow,
  decodeTrajectoryMetaRow,
} from 'sources/gemini/step-decode.ts';

interface DecodedGeminiRow {
  rowid: number;
  row: GeminiRowObject;
}

interface SliceMeasurement {
  redactedJson: string;
  rawBytes: number;
  compressed: Uint8Array;
}

export function collectOneGeminiTable(
  db: Database,
  file: DiscoveredGeminiFile,
  context: GeminiCollectorContext,
  table: GeminiTable,
  agentSchemaVersion: string,
  result: GeminiCollectorResult,
  identity: GeminiIdentity,
  currentSizeBytes: number,
  currentPageCount: number,
): void {
  if (!tableExists(db, table)) return;

  const priorCursor = identity.rotated
    ? null
    : getCursorWithFallback(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourceInode: null,
        watermarkTable: table,
      });
  const lastMaxRowid = priorCursor !== null ? priorCursor.watermarkEnd - 1 : -1;

  const decoded = readDecodedRows(db, table, lastMaxRowid);
  if (decoded.length === 0) {
    if (priorCursor !== null) {
      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourcePath: identity.sourcePath,
        sourceInode: null,
        watermarkTable: table,
        watermarkEnd: priorCursor.watermarkEnd,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
        consecutiveErrors: 0,
      });
    } else if (identity.rotated) {
      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: identity.sourcePathHash,
        sourcePath: identity.sourcePath,
        sourceInode: null,
        watermarkTable: table,
        watermarkEnd: 0,
        lastSeenSizeBytes: currentSizeBytes,
        lastSeenPageCount: currentPageCount,
        consecutiveErrors: 0,
      });
    }
    return;
  }

  const measureSlice = createSliceMeasurer();
  const slices = splitRowsByCompressedSize(decoded, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: context.maxDecompressedBytes,
    measureCompressed: (slice) => measureSlice(slice).compressed.byteLength,
    measureUncompressed: (slice) => measureSlice(slice).rawBytes,
  });

  if (slices.length > 1) {
    context.logger?.info(
      {
        event: 'capture.split_for_size',
        source_app: GEMINI_SOURCE_APP,
        source_path_hash: identity.sourcePathHash,
        watermark_table: table,
        total_slices: slices.length,
        row_count: decoded.length,
      },
      'oversized capture slice split into multiple batches',
    );
  }

  const lastRow = requireDefined(decoded[decoded.length - 1], 'last row');
  const finalWatermarkEnd = lastRow.rowid + 1;

  let quarantinedCount = 0;
  let acceptedSlices = 0;
  for (let i = 0; i < slices.length; i += 1) {
    const slice = requireDefined(slices[i], 'slice');
    if (slice.length === 0) continue;
    const firstRowidInSlice = requireDefined(slice[0], 'first row in slice').rowid;
    const lastRowidInSlice = requireDefined(slice[slice.length - 1], 'last row in slice').rowid;
    const sliceWatermarkEnd = lastRowidInSlice + 1;

    const measurement = measureSlice(slice);
    const redactedBytes = measurement.rawBytes;
    const compressed = measurement.compressed;

    if (redactedBytes > context.maxDecompressedBytes) {
      quarantineOversizedSlice(context, identity, table, {
        lastRowidInSlice,
        sliceWatermarkEnd,
        redactedBytes,
        currentSizeBytes,
        currentPageCount,
      });
      result.errors.push({
        sourcePath: identity.sourcePath,
        reason: `decompressed slice exceeded ${context.maxDecompressedBytes.toString()} bytes (${redactedBytes.toString()}); row quarantined`,
        table,
      });
      quarantinedCount += 1;
      continue;
    }

    if (slices.length > 1) {
      context.logger?.debug(
        {
          event: 'capture.chunked',
          source_app: GEMINI_SOURCE_APP,
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
      sourceApp: GEMINI_SOURCE_APP,
      sourcePlatform: file.sourcePlatform,
      sourceKind: GEMINI_SOURCE_KIND,
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
      bodyFormat: GEMINI_BODY_FORMAT,
      bodyCompression: GEMINI_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(context.buffer, batch);
    result.capturedBytes += compressed.byteLength;
    acceptedSlices += 1;
  }

  let finalConsecutiveErrors = 0;
  if (quarantinedCount > 0) {
    const refreshed = getCursor(context.buffer, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
    });
    finalConsecutiveErrors = refreshed?.consecutiveErrors ?? quarantinedCount;
  }
  setCursor(context.buffer, {
    sourceApp: GEMINI_SOURCE_APP,
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

interface QuarantineSliceInfo {
  lastRowidInSlice: number;
  sliceWatermarkEnd: number;
  redactedBytes: number;
  currentSizeBytes: number;
  currentPageCount: number;
}

function quarantineOversizedSlice(
  context: GeminiCollectorContext,
  identity: GeminiIdentity,
  table: GeminiTable,
  info: QuarantineSliceInfo,
): void {
  try {
    recordQuarantine(context.buffer, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePath: identity.sourcePath,
      sourcePathHash: identity.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
      watermarkPosition: info.lastRowidInSlice,
      rowPk: info.lastRowidInSlice.toString(),
      redactedSizeBytes: info.redactedBytes,
      reason: 'oversized_decompressed',
      quarantinedAtUtc: nowIsoUtc(),
      gatewayVersion: context.gatewayVersion,
    });
  } catch (qerr) {
    context.logger?.warn(
      {
        event: 'quarantine.write_failed',
        source_app: GEMINI_SOURCE_APP,
        source_path_hash: identity.sourcePathHash,
        error: qerr instanceof Error ? qerr.message : String(qerr),
      },
      'failed to record oversized row quarantine',
    );
  }
  context.logger?.warn(
    {
      event: 'oversized_row.quarantined',
      source_app: GEMINI_SOURCE_APP,
      source_path_hash: identity.sourcePathHash,
      watermark_table: table,
      watermark_position: info.lastRowidInSlice,
      redacted_size_bytes: info.redactedBytes,
      cap: context.maxDecompressedBytes,
    },
    'oversized gemini row quarantined; advancing cursor past it',
  );
  const refreshedCursor = getCursor(context.buffer, {
    sourceApp: GEMINI_SOURCE_APP,
    sourcePathHash: identity.sourcePathHash,
    sourceInode: null,
    watermarkTable: table,
  });
  const priorErrors = refreshedCursor?.consecutiveErrors ?? 0;
  setCursor(context.buffer, {
    sourceApp: GEMINI_SOURCE_APP,
    sourcePathHash: identity.sourcePathHash,
    sourcePath: identity.sourcePath,
    sourceInode: null,
    watermarkTable: table,
    watermarkEnd: info.sliceWatermarkEnd,
    consecutiveErrors: priorErrors + 1,
    lastSeenSizeBytes: info.currentSizeBytes,
    lastSeenPageCount: info.currentPageCount,
  });
}

function readDecodedRows(
  db: Database,
  table: GeminiTable,
  lastMaxRowid: number,
): DecodedGeminiRow[] {
  if (table === GEMINI_STEPS_TABLE) {
    return readStepRows(db, lastMaxRowid);
  }
  if (table === GEMINI_TRAJECTORY_META_TABLE) {
    return readTrajectoryMetaRows(db, lastMaxRowid);
  }
  return readTrajectoryMetadataBlobRows(db, lastMaxRowid);
}

interface RawStepRow {
  rid: number;
  idx: number | null;
  step_type: number | null;
  status: number | null;
  step_payload: Uint8Array | null;
}

function readStepRows(db: Database, lastMaxRowid: number): DecodedGeminiRow[] {
  const rows = db
    .query<
      RawStepRow,
      [number]
    >('SELECT rowid AS rid, idx, step_type, status, step_payload FROM "steps" WHERE rowid > ? ORDER BY rowid ASC')
    .all(lastMaxRowid);
  return rows.map((raw) => ({
    rowid: raw.rid,
    row: decodeStepRow(
      raw.idx ?? raw.rid,
      raw.step_type ?? 0,
      raw.status,
      toBytes(raw.step_payload),
    ),
  }));
}

interface RawTrajectoryMetaRow {
  rid: number;
  trajectory_id: string | null;
  cascade_id: string | null;
  trajectory_type: number | null;
  source: number | null;
}

function readTrajectoryMetaRows(db: Database, lastMaxRowid: number): DecodedGeminiRow[] {
  const rows = db
    .query<
      RawTrajectoryMetaRow,
      [number]
    >('SELECT rowid AS rid, trajectory_id, cascade_id, trajectory_type, source FROM "trajectory_meta" WHERE rowid > ? ORDER BY rowid ASC')
    .all(lastMaxRowid);
  return rows.map((raw) => ({
    rowid: raw.rid,
    row: decodeTrajectoryMetaRow({
      idx: raw.rid,
      trajectoryId: raw.trajectory_id,
      cascadeId: raw.cascade_id,
      trajectoryType: raw.trajectory_type,
      source: raw.source,
    }),
  }));
}

interface RawTrajectoryMetadataBlobRow {
  rid: number;
  data: Uint8Array | null;
}

function readTrajectoryMetadataBlobRows(db: Database, lastMaxRowid: number): DecodedGeminiRow[] {
  const rows = db
    .query<
      RawTrajectoryMetadataBlobRow,
      [number]
    >('SELECT rowid AS rid, data FROM "trajectory_metadata_blob" WHERE rowid > ? ORDER BY rowid ASC')
    .all(lastMaxRowid);
  return rows.map((raw) => ({
    rowid: raw.rid,
    row: decodeTrajectoryMetadataBlobRow(raw.rid, toBytes(raw.data)),
  }));
}

function toBytes(value: Uint8Array | null): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function createSliceMeasurer(): (slice: readonly DecodedGeminiRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly DecodedGeminiRow[], SliceMeasurement>();
  return (slice) => {
    const cached = cache.get(slice);
    if (cached !== undefined) return cached;
    const rows = slice.map((entry) => entry.row);
    const redactedJson = applyRedaction(JSON.stringify(rows)).redacted;
    const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
    const compressed = zstdCompressSync(redactedJson);
    const entry: SliceMeasurement = { redactedJson, rawBytes, compressed };
    cache.set(slice, entry);
    return entry;
  };
}

export interface GeminiUploadSize {
  telemetryRecordCount: number;
  rawBytes: number;
  compressedBytes: number;
}

export function measureGeminiUploadSize(
  db: Database,
  maxDecompressedBytes: number,
): GeminiUploadSize {
  let telemetryRecordCount = 0;
  let rawBytes = 0;
  let compressedBytes = 0;
  for (const table of GEMINI_ALLOWED_TABLES) {
    if (!tableExists(db, table)) continue;
    const decoded = readDecodedRows(db, table, -1);
    if (decoded.length === 0) continue;
    const measureSlice = createSliceMeasurer();
    const slices = splitRowsByCompressedSize(decoded, {
      targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
      maxDecompressedBytes,
      measureCompressed: (slice) => measureSlice(slice).compressed.byteLength,
      measureUncompressed: (slice) => measureSlice(slice).rawBytes,
    });
    for (const slice of slices) {
      const measurement = measureSlice(slice);
      if (measurement.rawBytes > maxDecompressedBytes) continue;
      telemetryRecordCount += slice.length;
      rawBytes += measurement.rawBytes;
      compressedBytes += measurement.compressed.byteLength;
    }
  }
  return { telemetryRecordCount, rawBytes, compressedBytes };
}
