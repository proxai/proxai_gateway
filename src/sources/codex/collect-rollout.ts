import { readJsonlRange } from 'core/io/jsonl';
import { generateUuidV7, nowIsoUtc, splitJsonlAtBoundary, zstdCompressSync } from 'core/utils';
import { getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
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

    const redactedText = applyRedaction(DECODER.decode(range.bytes)).redacted;
    const redactedBytes = ENCODER.encode(redactedText);

    const slices = splitJsonlAtBoundary(redactedBytes, {
      targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
      measureCompressed: (b) => zstdCompressSync(b).byteLength,
    });

    if (slices.length > 1) {
      context.logger?.info(
        {
          event: 'capture.split_for_size',
          source_app: CODEX_SOURCE_APP,
          source_path_hash: file.sourcePathHash,
          total_slices: slices.length,
          uncompressed_bytes: redactedBytes.byteLength,
        },
        'oversized capture slice split into multiple batches',
      );
    }

    // Cursor advances after the LAST batch insert; intermediate failures
    // leave earlier batches buffered (with their own contiguous watermark
    // ranges) and the cursor unmoved — a future poll resumes from the
    // last-persisted boundary.
    let offset = 0;
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      const sliceEndOffset = offset + slice.byteLength;
      const compressed = zstdCompressSync(slice);

      if (slices.length > 1) {
        context.logger?.debug(
          {
            event: 'capture.chunked',
            source_app: CODEX_SOURCE_APP,
            source_path_hash: file.sourcePathHash,
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
        sourceKind: CODEX_ROLLOUT_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: watermarkStart + offset,
        watermarkEnd: watermarkStart + sliceEndOffset,
        watermarkTable: null,
        agentSchemaVersion,
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
    });

    result.capturedBatches = slices.length;
    result.capturedBytes = range.bytes.byteLength;
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
