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

const NEWLINE_BYTE = 0x0a;
const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

interface HeaderInfo {
  agentSchemaVersion: string;
  endByte: number;
}

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

    const header = await readHeader(file.sourcePath);

    let agentSchemaVersion: string;
    let eventStart: number;

    if (watermarkStart === 0) {
      if (header === null) {
        return result;
      }
      agentSchemaVersion = header.agentSchemaVersion;
      eventStart = header.endByte;

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
      agentSchemaVersion = header?.agentSchemaVersion ?? GEMINI_CLI_DEFAULT_AGENT_SCHEMA_VERSION;
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

async function readHeader(sourcePath: string): Promise<HeaderInfo | null> {
  const file = Bun.file(sourcePath);
  const slice = file.slice(0, GEMINI_CLI_HEADER_MAX_BYTES);
  const buf = new Uint8Array(await slice.arrayBuffer());
  const newlineIndex = buf.indexOf(NEWLINE_BYTE);
  if (newlineIndex === -1) return null;

  const headerLine = DECODER.decode(buf.subarray(0, newlineIndex));
  const endByte = newlineIndex + 1;

  let agentSchemaVersion = GEMINI_CLI_DEFAULT_AGENT_SCHEMA_VERSION;
  try {
    const parsed = JSON.parse(headerLine) as { kind?: unknown };
    if (typeof parsed.kind === 'string' && parsed.kind.length > 0) {
      agentSchemaVersion = `gemini-cli/${parsed.kind}`;
    }
  } catch {}

  return { agentSchemaVersion, endByte };
}
