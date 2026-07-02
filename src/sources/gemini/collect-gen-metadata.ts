import { openReadOnly, snapshotSqlite, tableExists } from 'core/io/sqlite';
import {
  generateUuidV7,
  nowIsoUtc,
  requireDefined,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import { getCursor, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { isFolderUnderPrefixes, normalizeExcludedPrefixes } from 'services/exclusion';
import { applyRedaction } from 'services/redaction';
import {
  GEMINI_BODY_COMPRESSION,
  GEMINI_GEN_METADATA_TABLE,
  GEMINI_SOURCE_APP,
  GEMINI_TOKEN_BODY_FORMAT,
  GEMINI_TOKEN_SOURCE_KIND,
  GEMINI_V3_AGENT_SCHEMA_VERSION,
} from 'sources/gemini/gemini.constants.ts';
import type {
  DiscoveredGeminiDbFile,
  GeminiCollectorContext,
  GeminiCollectorResult,
} from 'sources/gemini/gemini.types.ts';

/**
 * Content-free token capture: reads ONLY `gen_metadata` (token-count protobuf + ids,
 * NO conversation content) from a conversation `.db`, base64-encodes the `data` BLOB
 * (JSON.stringify silently corrupts a Uint8Array), and ships `sqlite_rows_json` STAMPED
 * with the transcript's source_path so it lands on the same chat as the jsonl content
 * capture (chat_id = source_path_hash). The jsonl content capture is untouched.
 *
 * Column allow-list is hard-coded to `{idx, data}` — never `SELECT *` — so no content
 * column can ever be shipped. Runs the per-conversation exclusion PAUSE gate (same as
 * `collect.ts`) BEFORE any DB read.
 */
// `idx` is INTEGER PRIMARY KEY (the rowid alias) — always present, and the watermark
// column. (bun:sqlite omits a bare `rowid` column from the row object, so we key on
// `idx` directly rather than SELECTing rowid.)
type GenMetadataRow = { idx: number; data: Uint8Array | null };

function serializeRows(rows: readonly GenMetadataRow[]): string {
  // BLOB → base64 so it round-trips (nest base64-decodes back to bytes). Ships {idx, data}.
  return JSON.stringify(
    rows.map((r) => ({
      idx: r.idx,
      data: r.data === null ? null : Buffer.from(r.data).toString('base64'),
    })),
  );
}

interface SliceMeasurement {
  redacted: string;
  rawBytes: number;
  compressed: Uint8Array;
}

function createSliceMeasurer(): (slice: readonly GenMetadataRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly GenMetadataRow[], SliceMeasurement>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redacted = applyRedaction(serializeRows(slice)).redacted;
      const rawBytes = Buffer.byteLength(redacted, 'utf8');
      entry = { redacted, rawBytes, compressed: zstdCompressSync(redacted) };
      cache.set(slice, entry);
    }
    return entry;
  };
}

export async function collectGeminiGenMetadata(
  file: DiscoveredGeminiDbFile,
  context: GeminiCollectorContext,
): Promise<GeminiCollectorResult> {
  const result: GeminiCollectorResult = { capturedBatches: 0, capturedBytes: 0, errors: [] };

  // EXCLUSION PAUSE GATE — before ANY DB read/insert/setCursor (mirrors collect.ts:64-103).
  // Fail-closed on a partial agyhub index; pause (no cursor advance → backfills) when excluded.
  const excluded = context.excludedProjects ?? [];
  if (excluded.length > 0) {
    if (context.agyhubComplete === false) {
      context.logger?.info(
        {
          event: 'capture.agyhub_partial_read_pause',
          source_app: GEMINI_SOURCE_APP,
          source_path_hash: file.transcriptSourcePathHash,
        },
        'agyhub index incomplete (mid-write?); pausing gen_metadata capture this cycle',
      );
      return result;
    }
    const prefixes = normalizeExcludedPrefixes(excluded);
    const folders = context.agyhubFolders?.get(file.conversationId) ?? [];
    const hit = folders.find((folder) => isFolderUnderPrefixes(folder, prefixes));
    if (hit !== undefined) {
      context.logger?.info(
        {
          event: 'capture.project_excluded',
          source_app: GEMINI_SOURCE_APP,
          source_path_hash: file.transcriptSourcePathHash,
          project: hit,
        },
        'paused gen_metadata capture for excluded antigravity conversation',
      );
      return result; // PAUSE: no setCursor → watermark frozen → backfills if un-excluded.
    }
  }

  let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;
  try {
    snapshot = await snapshotSqlite(file.dbPath);
    const db = openReadOnly(snapshot.path);
    try {
      if (!tableExists(db, GEMINI_GEN_METADATA_TABLE)) return result;

      const cursor = getCursorWithFallback(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.transcriptSourcePathHash,
        sourceInode: null,
        watermarkTable: GEMINI_GEN_METADATA_TABLE,
      });
      // gen_metadata.idx starts at 0 (gen#0), so the initial floor must be -1
      // (idx > -1 includes 0). Default to 0, NOT codex's 1 — a `?? 1` here would
      // drop the first generation's tokens forever.
      const lastMaxIdx = (cursor?.watermarkEnd ?? 0) - 1;

      // Hard-coded column allow-list — NEVER SELECT *. `idx`,`data` only.
      const rows = db
        .query<
          GenMetadataRow,
          [number]
        >(`SELECT idx, data FROM ${GEMINI_GEN_METADATA_TABLE} WHERE idx > ? ORDER BY idx ASC`)
        .all(lastMaxIdx);
      if (rows.length === 0) return result;

      const finalWatermarkEnd = requireDefined(rows[rows.length - 1], 'last row').idx + 1;

      const measure = createSliceMeasurer();
      const slices = splitRowsByCompressedSize(rows, {
        targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
        maxDecompressedBytes: context.maxDecompressedBytes,
        measureCompressed: (slice) => measure(slice).compressed.byteLength,
        measureUncompressed: (slice) => measure(slice).rawBytes,
      });

      for (const slice of slices) {
        if (slice.length === 0) continue;
        const firstIdx = requireDefined(slice[0], 'first row in slice').idx;
        const lastIdxInSlice = requireDefined(slice[slice.length - 1], 'last row in slice').idx;
        const { rawBytes, compressed } = measure(slice);
        if (rawBytes > context.maxDecompressedBytes) {
          throw new Error(
            `gen_metadata slice exceeded ${context.maxDecompressedBytes.toString()} bytes (${rawBytes.toString()})`,
          );
        }
        const batch: NewBatch = {
          captureId: generateUuidV7(),
          sourceApp: GEMINI_SOURCE_APP,
          sourcePlatform: file.sourcePlatform,
          sourceKind: GEMINI_TOKEN_SOURCE_KIND,
          sourcePath: file.transcriptSourcePath,
          sourcePathHash: file.transcriptSourcePathHash,
          sourceInode: null,
          watermarkKind: 'rowid_range',
          watermarkStart: firstIdx,
          watermarkEnd: lastIdxInSlice + 1,
          watermarkTable: GEMINI_GEN_METADATA_TABLE,
          agentSchemaVersion: GEMINI_V3_AGENT_SCHEMA_VERSION,
          gatewayVersion: context.gatewayVersion,
          capturedAtUtc: nowIsoUtc(),
          bodyFormat: GEMINI_TOKEN_BODY_FORMAT,
          bodyCompression: GEMINI_BODY_COMPRESSION,
          body: compressed,
        };
        insertBatch(context.buffer, batch);
        result.capturedBytes += compressed.byteLength;
        result.capturedBatches += 1;
      }

      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.transcriptSourcePathHash,
        sourcePath: file.transcriptSourcePath,
        sourceInode: null,
        watermarkTable: GEMINI_GEN_METADATA_TABLE,
        watermarkEnd: finalWatermarkEnd,
        consecutiveErrors: 0,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    result.errors.push({
      sourcePath: file.dbPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    try {
      const prior = getCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.transcriptSourcePathHash,
        sourceInode: null,
        watermarkTable: GEMINI_GEN_METADATA_TABLE,
      });
      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.transcriptSourcePathHash,
        sourcePath: file.transcriptSourcePath,
        sourceInode: null,
        watermarkTable: GEMINI_GEN_METADATA_TABLE,
        watermarkEnd: prior?.watermarkEnd ?? 1,
        consecutiveErrors: (prior?.consecutiveErrors ?? 0) + 1,
      });
    } catch {}
  } finally {
    if (snapshot !== null) await snapshot.cleanup();
  }

  return result;
}
