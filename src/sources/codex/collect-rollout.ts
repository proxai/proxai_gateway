import { readJsonlRange } from 'core/io/jsonl';
import { generateUuidV7, nowIsoUtc, zstdCompressSync } from 'core/utils';
import { getCursorWithFallback, insertBatch, setCursor } from 'services/buffer';
import type { NewBatch } from 'services/buffer';
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

    const text = new TextDecoder('utf-8', { fatal: false }).decode(range.bytes);
    const redaction = applyRedaction(text);
    const compressed = zstdCompressSync(redaction.redacted);

    const batch: NewBatch = {
      captureId: generateUuidV7(),
      sourceApp: CODEX_SOURCE_APP,
      sourceKind: CODEX_ROLLOUT_SOURCE_KIND,
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
      bodyFormat: CODEX_ROLLOUT_BODY_FORMAT,
      bodyCompression: CODEX_BODY_COMPRESSION,
      body: compressed,
    };

    insertBatch(context.buffer, batch);

    setCursor(context.buffer, {
      sourceApp: CODEX_SOURCE_APP,
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
