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
} from 'sources/codex/codex.constants.ts';
import type {
  CodexCollectorContext,
  CodexCollectorResult,
  DiscoveredCodexRolloutFile,
} from 'sources/codex/codex.types.ts';
import { extractRolloutCliVersion } from 'sources/codex/rollout-version.ts';

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

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

    const sourceSlices = splitJsonlAtBoundary(range.bytes, {
      targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
      maxDecompressedBytes: context.maxDecompressedBytes,
      measureCompressed: (slice) => {
        const redacted = ENCODER.encode(applyRedaction(DECODER.decode(slice)).redacted);
        return zstdCompressSync(redacted).byteLength;
      },
    });

    if (sourceSlices.length > 1) {
      context.logger?.info(
        {
          event: 'capture.split_for_size',
          source_app: CODEX_SOURCE_APP,
          source_path_hash: file.sourcePathHash,
          total_slices: sourceSlices.length,
          uncompressed_bytes: range.bytes.byteLength,
        },
        'oversized capture slice split into multiple batches',
      );
    }

    let offset = 0;
    for (let i = 0; i < sourceSlices.length; i++) {
      const slice = sourceSlices[i]!;
      const sliceEndOffset = offset + slice.byteLength;
      const redactedSlice = ENCODER.encode(applyRedaction(DECODER.decode(slice)).redacted);
      const compressed = zstdCompressSync(redactedSlice);

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
        watermarkStart: watermarkStart + offset,
        watermarkEnd: watermarkStart + sliceEndOffset,
        watermarkTable: null,
        agentSchemaVersion: effectiveAgentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CODEX_ROLLOUT_BODY_FORMAT,
        bodyCompression: CODEX_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);
      offset = sliceEndOffset;
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
    result.capturedBytes = range.bytes.byteLength;
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
    } catch {
      // best-effort error-counter bump; persistence failures are non-fatal
    }
  }

  return result;
}
