import { readJsonlRange } from 'core/io/jsonl';
import {
  OversizedDecompressedSliceError,
  generateUuidV7,
  nowIsoUtc,
  splitJsonlAtBoundary,
  zstdCompressSync,
} from 'core/utils';
import { getCursor, getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CODEX_BODY_COMPRESSION,
  CODEX_ROLLOUT_BODY_FORMAT,
  CODEX_ROLLOUT_SOURCE_KIND,
  CODEX_SOURCE_APP,
  CODEX_TURN_CONTROL_EVENT_MSG_TYPES,
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  DiscoveredCodexRolloutFile,
} from 'sources/codex/codex.types.ts';
import { extractRolloutCliVersion } from 'sources/codex/rollout-version.ts';

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

export function isCodexDialogueRecord(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.type === 'session_meta') {
    return true;
  }
  const payload = rec.payload;
  if (payload === null || typeof payload !== 'object') {
    return false;
  }
  const payloadType = (payload as { type?: unknown }).type;
  if (rec.type === 'event_msg') {
    return (
      typeof payloadType === 'string' && CODEX_TURN_CONTROL_EVENT_MSG_TYPES.includes(payloadType)
    );
  }
  if (rec.type === 'response_item') {
    if (payloadType !== 'message') {
      return false;
    }
    const role = (payload as { role?: unknown }).role;
    return role === 'user' || role === 'assistant';
  }
  return false;
}

export function trimCodexRecord(parsed: any): any {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
    const trimmedPayload = { ...parsed.payload };
    if ('base_instructions' in trimmedPayload) {
      trimmedPayload.base_instructions = '<trimmed>';
    }
    if ('dynamic_tools' in trimmedPayload) {
      trimmedPayload.dynamic_tools = [];
    }
    return {
      ...parsed,
      payload: trimmedPayload,
    };
  }
  return parsed;
}

export async function collectCodexRollout(
  file: DiscoveredCodexRolloutFile,
  context: CodexCollectorContext,
  agentSchemaVersion: string,
): Promise<CodexCollectorResult> {
  const result: CodexCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  try {
    const reader = context.rolloutVersionReader ?? extractRolloutCliVersion;
    const extracted = await reader(file.sourcePath);
    const effectiveAgentSchemaVersion = extracted ?? agentSchemaVersion;

    const cursor = getCursorWithFallback(context.buffer, {
      sourceApp: CODEX_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourceInode: file.inode,
      watermarkTable: null,
    });

    const watermarkStart = cursor?.watermarkEnd ?? 0;

    if (file.sizeBytes <= watermarkStart) {
      return result;
    }

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
          const parsed = JSON.parse(line);
          if (isCodexDialogueRecord(parsed)) {
            const trimmed = trimCodexRecord(parsed);
            kept.push({
              text: JSON.stringify(trimmed),
              physicalEndOffset: lineEndOffset,
            });
          }
        } catch {}
      }
      currentOffset = lineEndOffset;
    }

    const filteredText = kept.map((k) => k.text).join('\n') + '\n';
    if (kept.length === 0) {
      setCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: file.inode,
        watermarkTable: null,
        watermarkEnd: range.endByte,
        consecutiveErrors: 0,
      });
      return result;
    }

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
          source_app: CODEX_SOURCE_APP,
          source_path_hash: file.sourcePathHash,
          total_slices: sourceSlices.length,
          uncompressed_bytes: filteredBytes.byteLength,
        },
        'oversized capture slice split into multiple batches',
      );
    }

    let keptLineIndex = 0;
    for (let i = 0; i < sourceSlices.length; i++) {
      const slice = sourceSlices[i]!;

      let sliceNewlines = 0;
      for (let j = 0; j < slice.byteLength; j++) {
        if (slice[j] === 10) {
          sliceNewlines++;
        }
      }

      const startOffset = keptLineIndex > 0 ? kept[keptLineIndex - 1]!.physicalEndOffset : 0;
      let endOffset = kept[keptLineIndex + sliceNewlines - 1]!.physicalEndOffset;

      if (i === sourceSlices.length - 1) {
        endOffset = range.endByte - watermarkStart;
      }

      const { redactedBytes: redactedSlice, compressed } = redactSlice(slice);

      if (redactedSlice.byteLength > BODY_MAX_DECOMPRESSED_BYTES) {
        throw new OversizedDecompressedSliceError({
          sourcePath: file.sourcePath,
          sourcePathHash: file.sourcePathHash,
          rawBytes: redactedSlice.byteLength,
          compressedBytes: compressed.byteLength,
          sliceIndex: i,
          cap: BODY_MAX_DECOMPRESSED_BYTES,
        });
      }

      if (sourceSlices.length > 1) {
        context.logger?.debug(
          {
            event: 'capture.chunked',
            source_app: CODEX_SOURCE_APP,
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
        sourceApp: CODEX_SOURCE_APP,
        sourceKind: CODEX_ROLLOUT_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: watermarkStart + startOffset,
        watermarkEnd: watermarkStart + endOffset,
        watermarkTable: null,
        agentSchemaVersion: effectiveAgentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CODEX_ROLLOUT_BODY_FORMAT,
        bodyCompression: CODEX_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);
      keptLineIndex += sliceNewlines;
      result.capturedBytes += compressed.byteLength;
    }

    setCursor(context.buffer, {
      sourceApp: CODEX_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: file.inode,
      watermarkTable: null,
      watermarkEnd: range.endByte,
      consecutiveErrors: 0,
    });

    result.capturedBatches = sourceSlices.length;
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
    try {
      const priorCursor = getCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      const priorWatermarkEnd = priorCursor?.watermarkEnd ?? 0;
      setCursor(context.buffer, {
        sourceApp: CODEX_SOURCE_APP,
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
