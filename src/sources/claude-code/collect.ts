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
  CLAUDE_CODE_BODY_COMPRESSION,
  CLAUDE_CODE_BODY_FORMAT,
  CLAUDE_CODE_DEFAULT_AGENT_SCHEMA_VERSION,
  CLAUDE_CODE_SOURCE_APP,
  CLAUDE_CODE_SOURCE_KIND,
} from 'sources/claude-code/claude-code.constants.ts';
import type {
  ClaudeCodeCollectorContext,
  ClaudeCodeCollectorResult,
  DiscoveredClaudeCodeFile,
} from 'sources/claude-code/claude-code.types.ts';

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

export function isDialogueRecord(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  if (parsed.type === 'user') {
    let hasToolResult = false;
    const mContent = parsed.message?.content;
    const pContent = parsed.content;
    if (mContent && typeof mContent === 'object') {
      if (Array.isArray(mContent)) {
        hasToolResult = mContent.some(
          (item: any) => item && typeof item === 'object' && item.type === 'tool_result',
        );
      } else if ((mContent as any).type === 'tool_result') {
        hasToolResult = true;
      }
    }
    if (pContent && typeof pContent === 'object') {
      if (Array.isArray(pContent)) {
        hasToolResult =
          hasToolResult ||
          pContent.some(
            (item: any) => item && typeof item === 'object' && item.type === 'tool_result',
          );
      } else if ((pContent as any).type === 'tool_result') {
        hasToolResult = true;
      }
    }
    return !hasToolResult;
  }
  if (parsed.type === 'assistant') {
    let hasToolUse = false;
    const mContent = parsed.message?.content;
    const pContent = parsed.content;
    if (mContent && typeof mContent === 'object') {
      if (Array.isArray(mContent)) {
        hasToolUse = mContent.some(
          (item: any) => item && typeof item === 'object' && item.type === 'tool_use',
        );
      } else if ((mContent as any).type === 'tool_use') {
        hasToolUse = true;
      }
    }
    if (pContent && typeof pContent === 'object') {
      if (Array.isArray(pContent)) {
        hasToolUse =
          hasToolUse ||
          pContent.some(
            (item: any) => item && typeof item === 'object' && item.type === 'tool_use',
          );
      } else if ((pContent as any).type === 'tool_use') {
        hasToolUse = true;
      }
    }
    return !hasToolUse;
  }
  return false;
}

export async function collectClaudeCodeFile(
  file: DiscoveredClaudeCodeFile,
  context: ClaudeCodeCollectorContext,
): Promise<ClaudeCodeCollectorResult> {
  const result: ClaudeCodeCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  try {
    const cursor = getCursorWithFallback(context.buffer, {
      sourceApp: CLAUDE_CODE_SOURCE_APP,
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
          if (isDialogueRecord(parsed)) {
            kept.push({
              text: line,
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
        sourceApp: CLAUDE_CODE_SOURCE_APP,
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
    const redactedFullText = applyRedaction(filteredText).redacted;
    const agentSchemaVersion = extractAgentSchemaVersion(redactedFullText);

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
          source_app: CLAUDE_CODE_SOURCE_APP,
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
            source_app: CLAUDE_CODE_SOURCE_APP,
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
        sourceApp: CLAUDE_CODE_SOURCE_APP,
        sourceKind: CLAUDE_CODE_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: watermarkStart + startOffset,
        watermarkEnd: watermarkStart + endOffset,
        watermarkTable: null,
        agentSchemaVersion,
        gatewayVersion: context.gatewayVersion,
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CLAUDE_CODE_BODY_FORMAT,
        bodyCompression: CLAUDE_CODE_BODY_COMPRESSION,
        body: compressed,
      };

      insertBatch(context.buffer, batch);
      keptLineIndex += sliceNewlines;
      result.capturedBytes += compressed.byteLength;
    }

    setCursor(context.buffer, {
      sourceApp: CLAUDE_CODE_SOURCE_APP,
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
        sourceApp: CLAUDE_CODE_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      const priorWatermarkEnd = priorCursor?.watermarkEnd ?? 0;
      setCursor(context.buffer, {
        sourceApp: CLAUDE_CODE_SOURCE_APP,
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

function extractAgentSchemaVersion(jsonlText: string): string {
  let cursor = 0;
  const len = jsonlText.length;
  while (cursor < len) {
    const newlineIndex = jsonlText.indexOf('\n', cursor);
    const lineEnd = newlineIndex === -1 ? len : newlineIndex;
    const line = jsonlText.slice(cursor, lineEnd);
    cursor = newlineIndex === -1 ? len : newlineIndex + 1;
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as {
        message?: { version?: unknown };
        version?: unknown;
      };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
      if (typeof parsed.message?.version === 'string' && parsed.message.version.length > 0) {
        return parsed.message.version;
      }
    } catch {
      continue;
    }
  }
  return CLAUDE_CODE_DEFAULT_AGENT_SCHEMA_VERSION;
}
