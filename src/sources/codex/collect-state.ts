import type { Database } from 'bun:sqlite';

import { statFile } from 'core/io/fs';
import { maxRowid, openReadOnly, pageCount, snapshotSqlite, tableExists } from 'core/io/sqlite';
import {
  OversizedDecompressedSliceError,
  generateUuidV7,
  nextGenerationSuffix,
  nowIsoUtc,
  sha256Hex,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import { detectVacuum, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import type { CodexTable } from 'services/contract';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
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

interface SourceIdentity {
  sourcePath: string;
  sourcePathHash: string;
  rotated: boolean;
}

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

  const sliceMeasureCache = new WeakMap<
    readonly (Record<string, unknown> & { rowid: number })[],
    { redactedJson: string; rawBytes: number; compressedBytes: number }
  >();
  const measureSlice = (
    slice: readonly (Record<string, unknown> & { rowid: number })[],
  ): { redactedJson: string; rawBytes: number; compressedBytes: number } => {
    let entry = sliceMeasureCache.get(slice);
    if (entry === undefined) {
      const redactedJson = applyRedaction(JSON.stringify(slice)).redacted;
      const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
      const compressedBytes = zstdCompressSync(redactedJson).byteLength;
      entry = { redactedJson, rawBytes, compressedBytes };
      sliceMeasureCache.set(slice, entry);
    }
    return entry;
  };
  const measureCompressed = (
    slice: readonly (Record<string, unknown> & { rowid: number })[],
  ): number => measureSlice(slice).compressedBytes;
  const measureUncompressed = (
    slice: readonly (Record<string, unknown> & { rowid: number })[],
  ): number => measureSlice(slice).rawBytes;

  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: context.maxDecompressedBytes,
    measureCompressed,
    measureUncompressed,
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
