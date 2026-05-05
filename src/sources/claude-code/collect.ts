import { readJsonlRange } from 'core/io/jsonl';
import { generateUuidV7, nowIsoUtc, zstdCompressSync } from 'core/utils';
import { getCursor, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { applyStage1 } from 'services/redaction';
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
    const cursor = getCursor(context.buffer, {
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

    const text = DECODER.decode(range.bytes);
    const redaction = applyStage1(text);
    const agentSchemaVersion = extractAgentSchemaVersion(redaction.redacted);
    const compressed = zstdCompressSync(redaction.redacted);

    const batch: NewBatch = {
      captureId: generateUuidV7(),
      sourceApp: CLAUDE_CODE_SOURCE_APP,
      sourceKind: CLAUDE_CODE_SOURCE_KIND,
      sourcePath: file.sourcePath,
      sourcePathHash: file.sourcePathHash,
      sourceInode: file.inode,
      watermarkKind: 'byte_range',
      watermarkStart,
      watermarkEnd: range.endByte,
      watermarkTable: null,
      agentSchemaVersion,
      gatewayVersion: context.gatewayVersion,
      capturedAtUtc: nowIsoUtc(),
      bodyFormat: CLAUDE_CODE_BODY_FORMAT,
      bodyCompression: CLAUDE_CODE_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(context.buffer, batch);

    setCursor(context.buffer, {
      sourceApp: CLAUDE_CODE_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: file.inode,
      watermarkTable: null,
      watermarkEnd: range.endByte,
    });

    result.capturedBatches = 1;
    result.capturedBytes = range.bytes.byteLength;
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
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
