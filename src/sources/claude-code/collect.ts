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

const CLAUDE_SYNTHETIC_TEXT_PREFIXES = [
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<system-reminder>',
  '<local-command-caveat>',
];

function claudeTextItemValue(item: unknown): string | null {
  if (item === null || typeof item !== 'object') {
    return null;
  }
  const obj = item as { type?: unknown; text?: unknown };
  if (obj.type !== 'text' || typeof obj.text !== 'string') {
    return null;
  }
  return obj.text;
}

function claudeFirstText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = claudeTextItemValue(item);
      if (text !== null) {
        return text;
      }
    }
    return '';
  }
  return claudeTextItemValue(content) ?? '';
}

function isClaudeSyntheticText(text: string): boolean {
  const trimmed = text.trimStart();
  return CLAUDE_SYNTHETIC_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

interface ClaudeContentItem {
  type?: unknown;
  text?: unknown;
}
type ClaudeContent = unknown;

interface ClaudeRecord {
  type?: unknown;
  isMeta?: unknown;
  isApiErrorMessage?: unknown;
  message?: { content?: ClaudeContent; text?: unknown; model?: unknown };
  content?: ClaudeContent;
  text?: unknown;
}

function hasItemType(item: unknown, type: string): boolean {
  return item !== null && typeof item === 'object' && (item as ClaudeContentItem).type === type;
}

function contentContainsType(content: ClaudeContent, type: string): boolean {
  if (content === null || typeof content !== 'object') return false;
  if (Array.isArray(content)) {
    return content.some((item) => hasItemType(item, type));
  }
  return (content as ClaudeContentItem).type === type;
}

export function isDialogueRecord(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const record = parsed as ClaudeRecord;
  if (record.type !== 'user' && record.type !== 'assistant') {
    return false;
  }
  if (record.isMeta === true) {
    return false;
  }
  const mContent = record.message?.content;
  const pContent = record.content;
  const mText = record.message?.text;
  const pText = record.text;
  const actualContent =
    mContent !== undefined && mContent !== null
      ? mContent
      : pContent !== undefined && pContent !== null
        ? pContent
        : mText !== undefined && mText !== null
          ? mText
          : pText;

  if (actualContent === undefined || actualContent === null) {
    return false;
  }
  let hasText = false;
  if (Array.isArray(actualContent)) {
    hasText = actualContent.some((item: unknown) => {
      if (item === null || typeof item !== 'object') return false;
      const node = item as ClaudeContentItem;
      return node.type === 'text' && typeof node.text === 'string' && node.text.trim().length > 0;
    });
  } else if (typeof actualContent === 'object') {
    const node = actualContent as ClaudeContentItem;
    hasText = node.type === 'text' && typeof node.text === 'string' && node.text.trim().length > 0;
  } else if (typeof actualContent === 'string') {
    hasText = actualContent.trim().length > 0;
  } else {
    hasText = String(actualContent).trim().length > 0;
  }
  if (!hasText) {
    return false;
  }

  if (record.type === 'user') {
    if (isClaudeSyntheticText(claudeFirstText(actualContent))) {
      return false;
    }
    const hasToolResult =
      contentContainsType(mContent, 'tool_result') || contentContainsType(pContent, 'tool_result');
    return !hasToolResult;
  }

  if (record.message?.model === '<synthetic>' || record.isApiErrorMessage === true) {
    return false;
  }
  const hasToolUse =
    contentContainsType(mContent, 'tool_use') || contentContainsType(pContent, 'tool_use');
  return !hasToolUse;
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
