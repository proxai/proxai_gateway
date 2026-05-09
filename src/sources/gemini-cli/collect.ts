import { homedir } from 'node:os';

import { readJsonlRange } from 'core/io/jsonl';
import {
  OversizedDecompressedSliceError,
  generateUuidV7,
  nowIsoUtc,
  splitJsonlAtBoundary,
  zstdCompressSync,
} from 'core/utils';
import { getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  GEMINI_CLI_AGENT_SCHEMA_PREFIX,
  GEMINI_CLI_BODY_COMPRESSION,
  GEMINI_CLI_BODY_FORMAT,
  GEMINI_CLI_DEFAULT_AGENT_SCHEMA_VERSION,
  GEMINI_CLI_HEADER_MAX_BYTES,
  GEMINI_CLI_SOURCE_APP,
  GEMINI_CLI_SOURCE_KIND,
} from 'sources/gemini-cli/gemini-cli.constants.ts';
import type {
  DiscoveredGeminiCliFile,
  GeminiCliCollectorContext,
  GeminiCliCollectorResult,
} from 'sources/gemini-cli/gemini-cli.types.ts';
import { detectGeminiCliVersion } from 'sources/gemini-cli/version.ts';

const NEWLINE_BYTE = 0x0a;
const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

export async function collectGeminiCliFile(
  file: DiscoveredGeminiCliFile,
  context: GeminiCliCollectorContext,
): Promise<GeminiCliCollectorResult> {
  const result: GeminiCliCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  try {
    const cursor = getCursorWithFallback(context.buffer, {
      sourceApp: GEMINI_CLI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourceInode: file.inode,
      watermarkTable: null,
    });

    const watermarkStart = cursor?.watermarkEnd ?? 0;

    if (file.sizeBytes <= watermarkStart) {
      return result;
    }

    const detect = context.detectVersion ?? defaultDetectVersion;
    const detected = detect();
    const agentSchemaVersion =
      detected !== null
        ? `${GEMINI_CLI_AGENT_SCHEMA_PREFIX}${detected}`
        : GEMINI_CLI_DEFAULT_AGENT_SCHEMA_VERSION;

    let eventStart: number;

    if (watermarkStart === 0) {
      const headerEnd = await readHeaderEnd(file.sourcePath);
      if (headerEnd === null) {
        return result;
      }
      eventStart = headerEnd;

      if (file.sizeBytes <= eventStart) {
        setCursor(context.buffer, {
          sourceApp: GEMINI_CLI_SOURCE_APP,
          sourcePathHash: file.sourcePathHash,
          sourcePath: file.sourcePath,
          sourceInode: file.inode,
          watermarkTable: null,
          watermarkEnd: eventStart,
        });
        return result;
      }
    } else {
      eventStart = watermarkStart;
    }

    const range = await readJsonlRange(file.sourcePath, eventStart, file.sizeBytes);
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
          source_app: GEMINI_CLI_SOURCE_APP,
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
            source_app: GEMINI_CLI_SOURCE_APP,
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
        sourceApp: GEMINI_CLI_SOURCE_APP,
        sourceKind: GEMINI_CLI_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: eventStart + offset,
        watermarkEnd: eventStart + sliceEndOffset,
        watermarkTable: null,
        agentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: GEMINI_CLI_BODY_FORMAT,
        bodyCompression: GEMINI_CLI_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);
      offset = sliceEndOffset;
    }

    setCursor(context.buffer, {
      sourceApp: GEMINI_CLI_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: file.inode,
      watermarkTable: null,
      watermarkEnd: range.endByte,
    });

    result.capturedBatches = sourceSlices.length;
    result.capturedBytes = range.bytes.byteLength;
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

async function readHeaderEnd(sourcePath: string): Promise<number | null> {
  const file = Bun.file(sourcePath);
  const slice = file.slice(0, GEMINI_CLI_HEADER_MAX_BYTES);
  const buf = new Uint8Array(await slice.arrayBuffer());
  const newlineIndex = buf.indexOf(NEWLINE_BYTE);
  if (newlineIndex === -1) return null;
  return newlineIndex + 1;
}

function defaultDetectVersion(): string | null {
  return detectGeminiCliVersion({ homedir: homedir(), platform: process.platform });
}
