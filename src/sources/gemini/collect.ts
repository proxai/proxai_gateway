import { readJsonlRange } from 'core/io/jsonl';
import {
  OversizedDecompressedSliceError,
  generateUuidV7,
  nowIsoUtc,
  requireDefined,
  splitJsonlAtBoundary,
  zstdCompressSync,
} from 'core/utils';
import { getCursor, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { isProjectExcluded } from 'services/exclusion';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  GEMINI_BODY_COMPRESSION,
  GEMINI_BODY_FORMAT,
  GEMINI_DEFAULT_AGENT_SCHEMA_VERSION,
  GEMINI_SOURCE_APP,
  GEMINI_SOURCE_KIND,
} from 'sources/gemini/gemini.constants.ts';
import type {
  DiscoveredGeminiFile,
  GeminiCollectorContext,
  GeminiCollectorResult,
} from 'sources/gemini/gemini.types.ts';

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

interface SliceRedaction {
  redactedBytes: Uint8Array;
  compressed: Uint8Array;
}

function createSliceRedactor(): (slice: Uint8Array) => SliceRedaction {
  const cache = new WeakMap<Uint8Array, SliceRedaction>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedBytes = ENCODER.encode(applyRedaction(DECODER.decode(slice)).redacted);
      const compressed = zstdCompressSync(redactedBytes);
      entry = { redactedBytes, compressed };
      cache.set(slice, entry);
    }
    return entry;
  };
}

/**
 * Byte-range capture of an Antigravity `transcript.jsonl` (append-only plaintext), structurally
 * mirroring the claude-code collector. This is a RAW byte-capturer: every complete, non-empty,
 * JSON-parseable line is kept — there is NO type/content filter. Antigravity lines are
 * USER_EXPLICIT/MODEL/SYSTEM with types like USER_INPUT/PLANNER_RESPONSE/CONVERSATION_HISTORY,
 * none of which are claude-code's `user`/`assistant`, so importing isDialogueRecord here would
 * keep ZERO lines while still advancing the watermark (silent data loss). nest parses the steps;
 * the gateway ships the redacted bytes verbatim.
 */
export async function collectGeminiConversation(
  file: DiscoveredGeminiFile,
  context: GeminiCollectorContext,
): Promise<GeminiCollectorResult> {
  const result: GeminiCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  try {
    const cursor = getCursorWithFallback(context.buffer, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourceInode: file.inode,
      watermarkTable: null,
    });

    const watermarkStart = cursor?.watermarkEnd ?? 0;

    if (file.sizeBytes <= watermarkStart) {
      return result;
    }

    // EXCLUSION PAUSE GATE — must run BEFORE any read/insert/setCursor so an excluded
    // conversation's byte watermark stays frozen and backfills if it is later un-excluded.
    const excluded = context.excludedProjects ?? [];
    if (excluded.length > 0) {
      const folders = context.agyhubFolders?.get(file.conversationId) ?? [];
      const hit = folders.find((folder) => isProjectExcluded(folder, excluded));
      if (hit !== undefined) {
        context.logger?.info(
          {
            event: 'capture.project_excluded',
            source_app: GEMINI_SOURCE_APP,
            source_path_hash: file.sourcePathHash,
            project: hit,
          },
          'paused capture for excluded antigravity conversation',
        );
        // PAUSE: no setCursor -> watermark frozen -> backfills if un-excluded.
        return result;
      }
      // folders empty / conversation unknown -> fail-open (fall through, capture).
    }

    // readJsonlRange returns only COMPLETE lines (up to the last newline) and an endByte that
    // covers exactly those bytes — this IS the trailing-partial-line holdback.
    const range = await readJsonlRange(file.sourcePath, watermarkStart, file.sizeBytes);
    if (range.bytes.byteLength === 0) {
      return result;
    }

    const rawText = DECODER.decode(range.bytes);
    const lines = rawText.split('\n');

    interface KeptLine {
      text: string;
      physicalEndOffset: number;
    }
    const kept: KeptLine[] = [];

    let currentOffset = 0;
    for (const line of lines) {
      const lineByteLength = ENCODER.encode(line).byteLength;
      const lineEndOffset = currentOffset + lineByteLength + 1;

      if (line.trim().length > 0) {
        try {
          // Parse-guard only to drop unparseable junk. NO type/content filter (no isDialogueRecord).
          JSON.parse(line);
          kept.push({ text: line, physicalEndOffset: lineEndOffset });
        } catch {}
      }
      currentOffset = lineEndOffset;
    }

    if (kept.length === 0) {
      // No complete keepable line: advance the cursor over the scanned bytes without a batch
      // (mirrors claude-code) so we do not re-scan the same junk forever.
      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: file.inode,
        watermarkTable: null,
        watermarkEnd: range.endByte,
        consecutiveErrors: 0,
      });
      return result;
    }

    const filteredText = kept.map((k) => k.text).join('\n') + '\n';
    const filteredBytes = ENCODER.encode(filteredText);

    const redactSlice = createSliceRedactor();
    const sourceSlices = splitJsonlAtBoundary(filteredBytes, {
      targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
      maxDecompressedBytes: context.maxDecompressedBytes,
      measureCompressed: (slice) => redactSlice(slice).compressed.byteLength,
    });

    if (sourceSlices.length > 1) {
      context.logger?.info(
        {
          event: 'capture.split_for_size',
          source_app: GEMINI_SOURCE_APP,
          source_path_hash: file.sourcePathHash,
          total_slices: sourceSlices.length,
          uncompressed_bytes: filteredBytes.byteLength,
        },
        'oversized capture slice split into multiple batches',
      );
    }

    let keptLineIndex = 0;
    for (let i = 0; i < sourceSlices.length; i++) {
      const slice = requireDefined(sourceSlices[i], 'source slice');

      let sliceNewlines = 0;
      for (let j = 0; j < slice.byteLength; j++) {
        if (slice[j] === 10) {
          sliceNewlines++;
        }
      }

      const startOffset =
        keptLineIndex > 0
          ? requireDefined(kept[keptLineIndex - 1], 'kept prev').physicalEndOffset
          : 0;
      let endOffset = requireDefined(
        kept[keptLineIndex + sliceNewlines - 1],
        'kept end',
      ).physicalEndOffset;

      if (i === sourceSlices.length - 1) {
        endOffset = range.endByte - watermarkStart;
      }

      const { redactedBytes: redactedSlice, compressed } = redactSlice(slice);

      if (redactedSlice.byteLength > context.maxDecompressedBytes) {
        throw new OversizedDecompressedSliceError({
          sourcePath: file.sourcePath,
          sourcePathHash: file.sourcePathHash,
          rawBytes: redactedSlice.byteLength,
          compressedBytes: compressed.byteLength,
          sliceIndex: i,
          cap: context.maxDecompressedBytes,
        });
      }

      if (sourceSlices.length > 1) {
        context.logger?.debug(
          {
            event: 'capture.chunked',
            source_app: GEMINI_SOURCE_APP,
            source_path_hash: file.sourcePathHash,
            slice_index: i,
            total_slices: sourceSlices.length,
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
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: watermarkStart + startOffset,
        watermarkEnd: watermarkStart + endOffset,
        watermarkTable: null,
        agentSchemaVersion: GEMINI_DEFAULT_AGENT_SCHEMA_VERSION,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: GEMINI_BODY_FORMAT,
        bodyCompression: GEMINI_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);
      keptLineIndex += sliceNewlines;
      result.capturedBytes += compressed.byteLength;
    }

    setCursor(context.buffer, {
      sourceApp: GEMINI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: file.inode,
      watermarkTable: null,
      watermarkEnd: range.endByte,
      consecutiveErrors: 0,
    });

    result.capturedBatches = sourceSlices.length;
    result.capturedBytes = range.bytes.byteLength;
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    try {
      const priorCursor = getCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      const priorWatermarkEnd = priorCursor?.watermarkEnd ?? 0;
      setCursor(context.buffer, {
        sourceApp: GEMINI_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: file.inode,
        watermarkTable: null,
        watermarkEnd: priorWatermarkEnd,
        consecutiveErrors: priorErrors + 1,
      });
    } catch {}
  }

  return result;
}
