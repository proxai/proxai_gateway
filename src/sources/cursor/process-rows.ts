import {
  generateUuidV7,
  nowIsoUtc,
  requireDefined,
  splitRowsByCompressedSize,
  zstdCompressSync,
} from 'core/utils';
import { getCursor, insertBatch, recordQuarantine, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { BODY_MAX_DECOMPRESSED_BYTES, BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CURSOR_BODY_COMPRESSION,
  CURSOR_BODY_FORMAT,
  CURSOR_SOURCE_APP,
  CURSOR_SOURCE_KIND,
} from 'sources/cursor/cursor.constants.ts';
import type {
  CursorCollectorContext,
  CursorCollectorResult,
  CursorDiskKvRow,
} from 'sources/cursor/cursor.types.ts';

interface SliceMeasurement {
  redactedJson: string;
  rawBytes: number;
  compressed: Uint8Array;
}

export interface ProcessRowsInput {
  rows: CursorDiskKvRow[];
  context: CursorCollectorContext;
  agentSchemaVersion: string;
  effectiveSourcePath: string;
  effectiveSourcePathHash: string;
  currentSizeBytes: number;
  currentPageCount: number;
  finalWatermarkEnd: number;
  result: CursorCollectorResult;
}

export function isAgentKvConversationBlob(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const role = (parsed as { role?: unknown }).role;
  return role === 'user' || role === 'assistant';
}

const CURSOR_BUBBLE_KEEP_KEYS = [
  '_v',
  'type',
  'bubbleId',
  'text',
  'richText',
  'createdAt',
  'capabilityType',
  'toolFormerData',
  'thinking',
  'context',
];
const CURSOR_ENV_WRAPPER_PREFIXES = [
  '<user_info>',
  '<open_and_recently_viewed_files>',
  '<open_files>',
  '<recently_viewed_files>',
  '<agent_transcripts>',
];
const CURSOR_ARG_VALUE_MAX_BYTES = 512;

function trimCursorBubbleValue(source: Record<string, unknown>): string {
  const trimmed: Record<string, unknown> = {};
  for (const key of CURSOR_BUBBLE_KEEP_KEYS) {
    if (key in source) {
      trimmed[key] = source[key];
    }
  }
  return JSON.stringify(trimmed);
}

function isCursorEnvWrapperText(text: string): boolean {
  const trimmed = text.trimStart();
  return CURSOR_ENV_WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function trimCursorArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') > CURSOR_ARG_VALUE_MAX_BYTES
    ) {
      trimmed[key] = '<trimmed>';
    } else {
      trimmed[key] = value;
    }
  }
  return trimmed;
}

function trimCursorUserContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.filter((item) => {
    if (item === null || typeof item !== 'object') {
      return true;
    }
    const text = (item as { text?: unknown }).text;
    return typeof text !== 'string' || !isCursorEnvWrapperText(text);
  });
}

function trimCursorAssistantContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const trimmed: unknown[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') {
      trimmed.push(part);
      continue;
    }
    const partType = (part as { type?: unknown }).type;
    if (partType === 'reasoning' || partType === 'redacted-reasoning') {
      continue;
    }
    if (partType === 'tool-call') {
      const toolPart = part as Record<string, unknown>;
      trimmed.push({ ...toolPart, args: trimCursorArgs(toolPart.args) });
      continue;
    }
    trimmed.push(part);
  }
  return trimmed;
}

export function trimCursorRowValue(key: string, value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return value;
  }
  const source = parsed as Record<string, unknown>;
  if (key.startsWith('bubbleId:')) {
    return trimCursorBubbleValue(source);
  }
  if (key.startsWith('agentKv:blob:')) {
    if (source.role === 'user') {
      return JSON.stringify({ ...source, content: trimCursorUserContent(source.content) });
    }
    if (source.role === 'assistant') {
      return JSON.stringify({ ...source, content: trimCursorAssistantContent(source.content) });
    }
  }
  return value;
}

export function processRows(input: ProcessRowsInput): void {
  const filteredRows = input.rows.filter((row) => {
    if (row.key.startsWith('bubbleId:')) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object') {
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          return text.length > 0;
        }
      } catch {
        return false;
      }
      return false;
    }
    if (row.key.startsWith('agentKv:blob:')) {
      return isAgentKvConversationBlob(row.value);
    }
    return true;
  });

  const trimmedRows: CursorDiskKvRow[] = filteredRows.map((row) => ({
    rowid: row.rowid,
    key: row.key,
    value: trimCursorRowValue(row.key, row.value),
  }));

  const measureSlice = createSliceMeasurer();
  const slices = splitRowsByCompressedSize(trimmedRows, {
    targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
    maxDecompressedBytes: input.context.maxDecompressedBytes,
    measureCompressed: (slice) => measureSlice(slice).compressed.byteLength,
    measureUncompressed: (slice) => measureSlice(slice).rawBytes,
  });

  if (slices.length > 1) {
    input.context.logger?.info(
      {
        event: 'capture.split_for_size',
        source_app: CURSOR_SOURCE_APP,
        source_path_hash: input.effectiveSourcePathHash,
        total_slices: slices.length,
        row_count: input.rows.length,
      },
      'oversized capture slice split into multiple batches',
    );
  }

  let quarantinedCount = 0;
  let acceptedSlices = 0;
  for (let i = 0; i < slices.length; i++) {
    const slice = requireDefined(slices[i], 'slice');
    if (slice.length === 0) continue;
    const firstRowidInSlice = requireDefined(slice[0], 'first row in slice').rowid;
    const lastRowidInSlice = requireDefined(slice[slice.length - 1], 'last row in slice').rowid;
    const sliceWatermarkEnd = lastRowidInSlice + 1;

    const measurement = measureSlice(slice);
    const redactedBytes = measurement.rawBytes;
    const compressed = measurement.compressed;

    if (redactedBytes > BODY_MAX_DECOMPRESSED_BYTES) {
      try {
        recordQuarantine(input.context.buffer, {
          sourceApp: CURSOR_SOURCE_APP,
          sourcePath: input.effectiveSourcePath,
          sourcePathHash: input.effectiveSourcePathHash,
          sourceInode: null,
          watermarkTable: null,
          watermarkPosition: lastRowidInSlice,
          rowPk: lastRowidInSlice.toString(),
          redactedSizeBytes: redactedBytes,
          reason: 'oversized_decompressed',
          quarantinedAtUtc: nowIsoUtc(),
          gatewayVersion: input.context.gatewayVersion,
        });
      } catch (qerr) {
        input.context.logger?.warn(
          {
            event: 'quarantine.write_failed',
            source_app: CURSOR_SOURCE_APP,
            source_path_hash: input.effectiveSourcePathHash,
            error: qerr instanceof Error ? qerr.message : String(qerr),
          },
          'failed to record oversized row quarantine',
        );
      }
      input.context.logger?.warn(
        {
          event: 'oversized_row.quarantined',
          source_app: CURSOR_SOURCE_APP,
          source_path_hash: input.effectiveSourcePathHash,
          watermark_position: lastRowidInSlice,
          redacted_size_bytes: redactedBytes,
          cap: BODY_MAX_DECOMPRESSED_BYTES,
        },
        'oversized cursor kv row quarantined; advancing cursor past it',
      );
      input.result.errors.push({
        sourcePath: input.effectiveSourcePath,
        reason: `decompressed slice exceeded ${BODY_MAX_DECOMPRESSED_BYTES.toString()} bytes (${redactedBytes.toString()}); row quarantined`,
      });
      const priorCursor = getCursor(input.context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: input.effectiveSourcePathHash,
        sourceInode: null,
        watermarkTable: null,
      });
      const priorErrors = priorCursor?.consecutiveErrors ?? 0;
      setCursor(input.context.buffer, {
        sourceApp: CURSOR_SOURCE_APP,
        sourcePathHash: input.effectiveSourcePathHash,
        sourcePath: input.effectiveSourcePath,
        sourceInode: null,
        watermarkTable: null,
        watermarkEnd: sliceWatermarkEnd,
        consecutiveErrors: priorErrors + 1,
        lastSeenSizeBytes: input.currentSizeBytes,
        lastSeenPageCount: input.currentPageCount,
      });
      quarantinedCount += 1;
      continue;
    }

    if (slices.length > 1) {
      input.context.logger?.debug(
        {
          event: 'capture.chunked',
          source_app: CURSOR_SOURCE_APP,
          source_path_hash: input.effectiveSourcePathHash,
          slice_index: i,
          total_slices: slices.length,
          compressed_bytes: compressed.byteLength,
        },
        'capture chunk insert',
      );
    }

    const batch: NewBatch = {
      captureId: generateUuidV7(),
      sourceApp: CURSOR_SOURCE_APP,
      sourceKind: CURSOR_SOURCE_KIND,
      sourcePath: input.effectiveSourcePath,
      sourcePathHash: input.effectiveSourcePathHash,
      sourceInode: null,
      watermarkKind: 'rowid_range',
      watermarkStart: firstRowidInSlice,
      watermarkEnd: sliceWatermarkEnd,
      watermarkTable: null,
      agentSchemaVersion: input.agentSchemaVersion,
      gatewayVersion: input.context.gatewayVersion,
      capturedAtUtc: nowIsoUtc(),
      bodyFormat: CURSOR_BODY_FORMAT,
      bodyCompression: CURSOR_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(input.context.buffer, batch);
    input.result.capturedBytes += compressed.byteLength;
    acceptedSlices += 1;
  }

  let finalConsecutiveErrors = 0;
  if (quarantinedCount > 0) {
    const refreshed = getCursor(input.context.buffer, {
      sourceApp: CURSOR_SOURCE_APP,
      sourcePathHash: input.effectiveSourcePathHash,
      sourceInode: null,
      watermarkTable: null,
    });
    finalConsecutiveErrors = refreshed?.consecutiveErrors ?? quarantinedCount;
  }
  setCursor(input.context.buffer, {
    sourceApp: CURSOR_SOURCE_APP,
    sourcePathHash: input.effectiveSourcePathHash,
    sourcePath: input.effectiveSourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: input.finalWatermarkEnd,
    lastSeenSizeBytes: input.currentSizeBytes,
    lastSeenPageCount: input.currentPageCount,
    consecutiveErrors: finalConsecutiveErrors,
  });

  input.result.capturedBatches += acceptedSlices;
}

function createSliceMeasurer(): (slice: readonly CursorDiskKvRow[]) => SliceMeasurement {
  const cache = new WeakMap<readonly CursorDiskKvRow[], SliceMeasurement>();
  return (slice) => {
    let entry = cache.get(slice);
    if (entry === undefined) {
      const redactedJson = applyRedaction(JSON.stringify({ rows: slice })).redacted;
      const rawBytes = Buffer.byteLength(redactedJson, 'utf8');
      const compressed = zstdCompressSync(redactedJson);
      entry = { redactedJson, rawBytes, compressed };
      cache.set(slice, entry);
    }
    return entry;
  };
}
