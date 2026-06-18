import { join, dirname } from 'node:path';
import { statFile } from 'core/io/fs';
import { readJsonlRange } from 'core/io/jsonl';
import { isProjectExcluded } from 'services/exclusion';
import {
  generateUuidV7,
  nowIsoUtc,
  requireDefined,
  splitJsonlAtBoundary,
  zstdCompressSync,
} from 'core/utils';
import { getCursorWithFallback, setCursor, insertBatch } from 'services/buffer';
import { BODY_TARGET_COMPRESSED_BYTES } from 'services/contract';
import { applyRedaction } from 'services/redaction';
import {
  CLAUDE_DESKTOP_BODY_COMPRESSION,
  CLAUDE_DESKTOP_BODY_FORMAT,
  CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION,
  CLAUDE_DESKTOP_SOURCE_APP,
  CLAUDE_DESKTOP_SOURCE_KIND,
  CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN,
} from 'sources/claude-desktop/claude-desktop.constants.ts';
import type {
  ClaudeDesktopCollectorContext,
  ClaudeDesktopCollectorResult,
  DiscoveredClaudeDesktopFile,
} from 'sources/claude-desktop/claude-desktop.types.ts';
import { isDialogueRecord } from 'sources/claude-code';

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

interface CliMetadata {
  cwd: string;
  version: string;
  gitBranch: string;
  sessionId: string;
}

async function loadCliMetadataMap(sessionDir: string): Promise<{
  userMap: Map<string, CliMetadata>;
  assistantMap: Map<string, CliMetadata>;
}> {
  const userMap = new Map<string, CliMetadata>();
  const assistantMap = new Map<string, CliMetadata>();

  const glob = new Bun.Glob(CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN);
  for await (const relativePath of glob.scan({ cwd: sessionDir, onlyFiles: true, dot: true })) {
    const filePath = join(sessionDir, relativePath);
    const stat = await statFile(filePath);
    if (!stat.exists) continue;

    try {
      const bytes = await Bun.file(filePath).arrayBuffer();
      const text = DECODER.decode(new Uint8Array(bytes));
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const rec = JSON.parse(line);
        const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
        const version = typeof rec.version === 'string' ? rec.version : '';
        const gitBranch = typeof rec.gitBranch === 'string' ? rec.gitBranch : '';
        const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';

        const meta: CliMetadata = { cwd, version, gitBranch, sessionId };

        if (rec.type === 'user' && typeof rec.uuid === 'string') {
          userMap.set(rec.uuid, meta);
        } else if (rec.type === 'assistant') {
          const msgId = rec.message?.id;
          if (typeof msgId === 'string') {
            assistantMap.set(msgId, meta);
          }
        }
      }
    } catch {}
  }

  return { userMap, assistantMap };
}

export async function collectClaudeDesktopFile(
  file: DiscoveredClaudeDesktopFile,
  context: ClaudeDesktopCollectorContext,
): Promise<ClaudeDesktopCollectorResult> {
  const result: ClaudeDesktopCollectorResult = {
    capturedBatches: 0,
    capturedBytes: 0,
    errors: [],
  };

  try {
    const cursor = getCursorWithFallback(context.buffer, {
      sourceApp: CLAUDE_DESKTOP_SOURCE_APP,
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

    const sessionDir = dirname(file.sourcePath);
    const { userMap, assistantMap } = await loadCliMetadataMap(sessionDir);

    const excluded = context.excludedProjects ?? [];
    if (excluded.length > 0) {
      // A desktop audit.jsonl can correlate records to MULTIPLE project cwds. Pause the whole
      // file if ANY correlated cwd is excluded (all-or-nothing PAUSE, matching the per-file
      // model) — checking only the first cwd would leak an excluded project's later records.
      for (const meta of [...userMap.values(), ...assistantMap.values()]) {
        if (meta.cwd.trim().length > 0 && isProjectExcluded(meta.cwd, excluded)) {
          context.logger?.info(
            {
              event: 'capture.project_excluded',
              source_app: CLAUDE_DESKTOP_SOURCE_APP,
              project: meta.cwd,
            },
            'paused capture for excluded project',
          );
          // PAUSE: no setCursor -> watermark frozen -> backfills if un-excluded.
          return result;
        }
      }
    }

    const rawText = DECODER.decode(range.bytes);
    const lines = rawText.split('\n');
    const keptLines: string[] = [];

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.isReplay === true || !isDialogueRecord(parsed)) {
          continue;
        }

        let cliMeta: CliMetadata | undefined;
        if (parsed.type === 'user' && typeof parsed.uuid === 'string') {
          cliMeta = userMap.get(parsed.uuid);
        } else if (parsed.type === 'assistant') {
          const msgId = parsed.message?.id;
          if (typeof msgId === 'string') {
            cliMeta = assistantMap.get(msgId);
          }
        }

        if (cliMeta !== undefined) {
          parsed.cwd = cliMeta.cwd;
          parsed.gitBranch = cliMeta.gitBranch;
          parsed.cliSessionId = cliMeta.sessionId;
          parsed.agentVersion = cliMeta.version;
        }

        if (typeof parsed.session_id === 'string') {
          parsed.desktopSessionId = parsed.session_id;
          delete parsed.session_id;
        }
        if (typeof parsed.client_platform === 'string') {
          parsed.clientPlatform = parsed.client_platform;
          delete parsed.client_platform;
        }

        keptLines.push(JSON.stringify(parsed));
      } catch {}
    }

    if (keptLines.length === 0) {
      setCursor(context.buffer, {
        sourceApp: CLAUDE_DESKTOP_SOURCE_APP,
        sourcePathHash: file.sourcePathHash,
        sourcePath: file.sourcePath,
        sourceInode: file.inode,
        watermarkTable: null,
        watermarkEnd: range.endByte,
        consecutiveErrors: 0,
      });
      return result;
    }

    const filteredText = keptLines.join('\n') + '\n';
    const filteredBytes = ENCODER.encode(filteredText);

    let agentSchemaVersion = CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION;
    const firstLine = keptLines[0];
    if (firstLine !== undefined) {
      try {
        const first = JSON.parse(firstLine);
        if (typeof first.agentVersion === 'string' && first.agentVersion.length > 0) {
          agentSchemaVersion = `claude-desktop/${first.agentVersion}`;
        }
      } catch {}
    }

    const redactSlice = (slice: Uint8Array) => {
      const redacted = ENCODER.encode(applyRedaction(DECODER.decode(slice)).redacted);
      const compressed = zstdCompressSync(redacted);
      return { redactedBytes: redacted, compressed };
    };

    const sourceSlices = splitJsonlAtBoundary(filteredBytes, {
      targetCompressedBytes: BODY_TARGET_COMPRESSED_BYTES,
      maxDecompressedBytes: context.maxDecompressedBytes,
      measureCompressed: (slice) => redactSlice(slice).compressed.byteLength,
    });

    for (let i = 0; i < sourceSlices.length; i++) {
      const slice = requireDefined(sourceSlices[i], 'source slice');
      const { redactedBytes, compressed } = redactSlice(slice);

      const captureId = generateUuidV7();
      insertBatch(context.buffer, {
        captureId,
        sourceApp: CLAUDE_DESKTOP_SOURCE_APP,
        sourcePlatform: 'claude-cowork-desktop',
        sourceKind: CLAUDE_DESKTOP_SOURCE_KIND,
        sourcePath: file.sourcePath,
        sourcePathHash: file.sourcePathHash,
        sourceInode: file.inode,
        watermarkKind: 'byte_range',
        watermarkStart: Number(watermarkStart),
        watermarkEnd: Number(range.endByte),
        watermarkTable: null,
        agentSchemaVersion,
        gatewayVersion: '2026.5.28',
        capturedAtUtc: nowIsoUtc(),
        bodyFormat: CLAUDE_DESKTOP_BODY_FORMAT,
        bodyCompression: CLAUDE_DESKTOP_BODY_COMPRESSION,
        body: compressed,
      });

      result.capturedBatches++;
      result.capturedBytes += redactedBytes.byteLength;
    }

    setCursor(context.buffer, {
      sourceApp: CLAUDE_DESKTOP_SOURCE_APP,
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: file.inode,
      watermarkTable: null,
      watermarkEnd: range.endByte,
      consecutiveErrors: 0,
    });
  } catch (err) {
    result.errors.push({
      sourcePath: file.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
