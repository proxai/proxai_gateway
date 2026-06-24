import { openReadOnly, snapshotSqlite } from 'core/io/sqlite';
import { requireDefined, zstdCompressSync } from 'core/utils';
import { openInMemoryBufferDb } from 'services/buffer/db.ts';
import type {
  BodyCompression,
  BodyFormat,
  SourceApp,
  SourceKind,
  SourcePlatform,
  WatermarkKind,
} from 'services/contract';
import {
  makeClaudeCodeSourcePoller,
  type ClaudeCodeSourcePollerOptions,
} from 'services/polling/poll-claude-code.ts';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';
import { makeCursorSourcePoller } from 'services/polling/poll-cursor.ts';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';
import {
  discoverClaudeCodeFiles,
  defaultClaudeCodeProjectsRoot,
  isDialogueRecord,
  slimClaudeUsageRecord,
} from 'sources/claude-code';
import {
  discoverClaudeDesktopFiles,
  defaultClaudeDesktopSessionsRoot,
} from 'sources/claude-desktop';
import {
  discoverCodexRolloutFiles,
  defaultCodexHome,
  isCodexDialogueRecord,
  trimCodexRecord,
} from 'sources/codex';
import {
  discoverCursorFiles,
  defaultCursorUserRoot,
  isAgentKvConversationBlob,
  trimCursorRowValue,
} from 'sources/cursor';
import {
  discoverGeminiTranscripts,
  defaultGeminiAntigravityBaseDir,
  type DiscoveredGeminiFile,
} from 'sources/gemini';

declare const self:
  | {
      onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
      postMessage: (message: WorkerOutput) => void;
    }
  | undefined;

function createCompressedSizer(): { add: (text: string) => void; finish: () => number } {
  const flushThresholdBytes = 4 * 1024 * 1024;
  let pending = '';
  let compressedTotal = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    compressedTotal += zstdCompressSync(pending).byteLength;
    pending = '';
  };
  return {
    add: (text: string): void => {
      pending += text;
      if (pending.length >= flushThresholdBytes) flush();
    },
    finish: (): number => {
      flush();
      return compressedTotal;
    },
  };
}

function isPromptRecord(
  parsed: unknown,
  sourceApp: 'claude-code' | 'codex' | 'claude-desktop' | 'gemini',
): boolean {
  const rec = parsed as Record<string, unknown>;
  if (sourceApp === 'codex') {
    if (rec.type !== 'response_item') {
      return false;
    }
    const payload = rec.payload;
    return (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as { role?: unknown }).role === 'user'
    );
  }
  if (sourceApp === 'gemini') {
    // Antigravity user prompts: a USER_EXPLICIT source with a USER_INPUT type.
    return rec.source === 'USER_EXPLICIT' && rec.type === 'USER_INPUT';
  }
  return rec.type === 'user';
}

function isCursorPromptRow(key: string, value: string | null): boolean {
  if (value === null) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const rec = parsed as Record<string, unknown>;
  if (key.startsWith('bubbleId:')) {
    return rec.type === 1;
  }
  if (key.startsWith('agentKv:blob:')) {
    return rec.role === 'user';
  }
  return false;
}

async function analyzeJsonlLogFile(
  filePath: string,
  sourceApp: 'claude-code' | 'codex' | 'claude-desktop' | 'gemini',
): Promise<{
  totalLines: number;
  oldestDate: string | null;
  newestDate: string | null;
  telemetryRecordCount: number;
  telemetryRawBytes: number;
  telemetryCompressedBytes: number;
  promptCount: number;
  error: string | null;
}> {
  let totalLines = 0;
  let oldestDate: string | null = null;
  let newestDate: string | null = null;
  let telemetryRecordCount = 0;
  let telemetryRawBytes = 0;
  let promptCount = 0;
  let error: string | null = null;
  const sizer = createCompressedSizer();
  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const lines = content.split('\n');
    const processLine = (line: string) => {
      if (line.trim().length === 0) return;
      totalLines++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      let ts: unknown;
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        ts = rec.timestamp ?? rec.created_at ?? rec.time;
      }
      if (typeof ts === 'string' && !isNaN(Date.parse(ts))) {
        const dateStr = new Date(ts).toISOString();
        if (oldestDate === null || Date.parse(dateStr) < Date.parse(oldestDate)) {
          oldestDate = dateStr;
        }
        if (newestDate === null || Date.parse(dateStr) > Date.parse(newestDate)) {
          newestDate = dateStr;
        }
      }
      let match = false;
      let capturedText = line;
      let lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (sourceApp === 'claude-code') {
        match = isDialogueRecord(parsed);
        if (!match) {
          // mirror collect.ts: recovered usage-bearing tool_use records ARE
          // shipped, so count them here too (consent-surface == shipped bytes).
          const slim = slimClaudeUsageRecord(parsed);
          if (slim !== null) {
            match = true;
            capturedText = JSON.stringify(slim);
            lineBytes = Buffer.byteLength(capturedText, 'utf8') + 1;
          }
        }
      } else if (sourceApp === 'claude-desktop') {
        // Desktop ships no slim records (out of scope) — dialogue-only.
        match = isDialogueRecord(parsed);
      } else if (sourceApp === 'codex') {
        match = isCodexDialogueRecord(parsed);
        if (match) {
          capturedText = JSON.stringify(trimCodexRecord(parsed));
          lineBytes = Buffer.byteLength(capturedText, 'utf8') + 1;
        }
      } else if (sourceApp === 'gemini') {
        // Keep-all, mirroring the gemini collector: every non-empty, JSON-parseable line is
        // captured verbatim (no type/content filter). capturedText/lineBytes already reflect the
        // raw line, so the consent-surface bytes match what is actually shipped.
        match = true;
      }
      if (match) {
        telemetryRecordCount++;
        telemetryRawBytes += lineBytes;
        sizer.add(capturedText + '\n');
        if (isPromptRecord(parsed, sourceApp)) {
          promptCount++;
        }
      }
    };
    for (const line of lines) {
      processLine(line);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    totalLines,
    oldestDate,
    newestDate,
    telemetryRecordCount,
    telemetryRawBytes,
    telemetryCompressedBytes: sizer.finish(),
    promptCount,
    error,
  };
}

async function discoverGeminiFilesForInspect(
  baseDir: string | undefined,
): Promise<DiscoveredGeminiFile[]> {
  try {
    return await discoverGeminiTranscripts(baseDir ?? defaultGeminiAntigravityBaseDir(), {
      minimumMtime: null,
    });
  } catch {
    return [];
  }
}

export async function handleInspect(
  sourceName: string,
  options: WorkerInput['options'],
): Promise<Required<WorkerOutput>['inspectResult']> {
  let filesProcessed = 0;
  let recordCount = 0;
  let telemetryRecordCount = 0;
  let totalBytes = 0;
  let telemetryRawBytes = 0;
  let telemetryCompressedBytes = 0;
  let promptCount = 0;
  let oldestDateMs = Infinity;
  let newestDateMs = -Infinity;
  const errors: string[] = [];

  const updateChronological = (dateStr: string | null, fallbackMs: number) => {
    if (dateStr !== null) {
      const ms = Date.parse(dateStr);
      if (Number.isFinite(ms)) {
        if (ms < oldestDateMs) oldestDateMs = ms;
        if (ms > newestDateMs) newestDateMs = ms;
      }
    } else {
      if (fallbackMs < oldestDateMs) oldestDateMs = fallbackMs;
      if (fallbackMs > newestDateMs) newestDateMs = fallbackMs;
    }
  };

  if (sourceName === 'claude-code') {
    const baseDir = options.baseDir ?? defaultClaudeCodeProjectsRoot();
    const files = await discoverClaudeCodeFiles(baseDir, {
      minimumMtime: null,
      captureSubAgents: options.captureSubAgents,
    });
    for (const f of files) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      const {
        totalLines,
        oldestDate,
        newestDate,
        telemetryRecordCount: telCount,
        telemetryRawBytes: telBytes,
        telemetryCompressedBytes: telComp,
        promptCount: telPrompts,
        error,
      } = await analyzeJsonlLogFile(f.sourcePath, 'claude-code');
      recordCount += totalLines;
      updateChronological(oldestDate, f.lastModifiedMs);
      updateChronological(newestDate, f.lastModifiedMs);

      telemetryRawBytes += telBytes;
      telemetryCompressedBytes += telComp;
      telemetryRecordCount += telCount;
      promptCount += telPrompts;
      if (error !== null) {
        errors.push(`${f.sourcePath}: ${error}`);
      }
    }
  } else if (sourceName === 'claude-desktop') {
    const baseDir = options.baseDir ?? defaultClaudeDesktopSessionsRoot();
    const files = await discoverClaudeDesktopFiles(baseDir, {
      minimumMtime: null,
    });
    for (const f of files) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      const {
        totalLines,
        oldestDate,
        newestDate,
        telemetryRecordCount: telCount,
        telemetryRawBytes: telBytes,
        telemetryCompressedBytes: telComp,
        promptCount: telPrompts,
        error,
      } = await analyzeJsonlLogFile(f.sourcePath, 'claude-desktop');
      recordCount += totalLines;
      updateChronological(oldestDate, f.lastModifiedMs);
      updateChronological(newestDate, f.lastModifiedMs);

      telemetryRawBytes += telBytes;
      telemetryCompressedBytes += telComp;
      telemetryRecordCount += telCount;
      promptCount += telPrompts;
      if (error !== null) errors.push(`${f.sourcePath}: ${error}`);
    }
  } else if (sourceName === 'cursor') {
    const baseDir = options.baseDir ?? defaultCursorUserRoot();
    const files = await discoverCursorFiles(baseDir, { minimumMtime: null });
    for (const f of files) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      updateChronological(null, f.lastModifiedMs);

      let snapshot: { path: string; cleanup: () => Promise<void> } | null = null;
      try {
        snapshot = await snapshotSqlite(f.sourcePath);
        const db = openReadOnly(snapshot.path);
        try {
          const tableCheck = db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
            .get();
          if (tableCheck !== null) {
            const countSql = 'SELECT COUNT(*) AS count FROM cursorDiskKV';
            const row = db.query<{ count: number }, []>(countSql).get();
            if (row !== null) {
              recordCount += row.count;
            }

            const prefixes = ['composerData:', 'bubbleId:', 'agentKv:blob:'];
            const clauses = prefixes.map((p) => `key LIKE '${p}%'`).join(' OR ');
            const rowsSql = `SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE ${clauses}`;
            const dbRows = db.query<{ key: string; value: string | null }, []>(rowsSql).all();

            const sizer = createCompressedSizer();
            for (const r of dbRows) {
              let keep = true;
              if (r.key.startsWith('bubbleId:')) {
                if (r.value === null) {
                  keep = false;
                } else {
                  try {
                    const parsed: unknown = JSON.parse(r.value);
                    if (parsed !== null && typeof parsed === 'object' && 'text' in parsed) {
                      const rawText = (parsed as { text?: unknown }).text;
                      keep = typeof rawText === 'string' && rawText.trim().length > 0;
                    } else {
                      keep = false;
                    }
                  } catch {
                    keep = false;
                  }
                }
              } else if (r.key.startsWith('agentKv:blob:')) {
                keep = r.value !== null && isAgentKvConversationBlob(r.value);
              }
              if (keep) {
                telemetryRecordCount++;
                const trimmed = trimCursorRowValue(r.key, r.value ?? '');
                telemetryRawBytes += Buffer.byteLength(trimmed, 'utf8');
                sizer.add(trimmed + '\n');
                if (isCursorPromptRow(r.key, r.value)) {
                  promptCount++;
                }
              }
            }
            telemetryCompressedBytes += sizer.finish();
          }
        } finally {
          db.close();
        }
      } catch (err) {
        errors.push(`${f.sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (snapshot !== null) {
          await snapshot.cleanup();
        }
      }
    }
  } else if (sourceName === 'codex') {
    const baseDir = options.baseDir ?? defaultCodexHome();

    try {
      const rolloutFiles = await discoverCodexRolloutFiles(baseDir, {
        minimumMtime: null,
        captureSubAgents: options.captureSubAgents,
      });
      for (const f of rolloutFiles) {
        filesProcessed++;
        totalBytes += f.sizeBytes;
        const {
          totalLines,
          oldestDate,
          newestDate,
          telemetryRecordCount: telCount,
          telemetryRawBytes: telBytes,
          telemetryCompressedBytes: telComp,
          promptCount: telPrompts,
          error,
        } = await analyzeJsonlLogFile(f.sourcePath, 'codex');
        recordCount += totalLines;
        updateChronological(oldestDate, f.lastModifiedMs);
        updateChronological(newestDate, f.lastModifiedMs);

        telemetryRawBytes += telBytes;
        telemetryCompressedBytes += telComp;
        telemetryRecordCount += telCount;
        promptCount += telPrompts;
        if (error !== null) {
          errors.push(`${f.sourcePath}: ${error}`);
        }
      }
    } catch (err) {
      errors.push(`codex rollout: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (sourceName === 'gemini') {
    const geminiFiles = await discoverGeminiFilesForInspect(options.baseDir);
    for (const f of geminiFiles) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      const {
        totalLines,
        oldestDate,
        newestDate,
        telemetryRecordCount: telCount,
        telemetryRawBytes: telBytes,
        telemetryCompressedBytes: telComp,
        promptCount: telPrompts,
        error,
      } = await analyzeJsonlLogFile(f.sourcePath, 'gemini');
      recordCount += totalLines;
      updateChronological(oldestDate, f.lastModifiedMs);
      updateChronological(newestDate, f.lastModifiedMs);

      telemetryRawBytes += telBytes;
      telemetryCompressedBytes += telComp;
      telemetryRecordCount += telCount;
      promptCount += telPrompts;
      if (error !== null) {
        errors.push(`${f.sourcePath}: ${error}`);
      }
    }
  }

  return {
    filesProcessed,
    recordCount,
    telemetryRecordCount,
    promptCount,
    totalBytes,
    telemetryRawBytes,
    telemetryCompressedBytes,
    oldestDate: oldestDateMs === Infinity ? null : new Date(oldestDateMs).toISOString(),
    newestDate: newestDateMs === -Infinity ? null : new Date(newestDateMs).toISOString(),
    errors,
  };
}

export async function handleCapture(
  sourceName: string,
  options: WorkerInput['options'],
): Promise<Required<WorkerOutput>['captureResult']> {
  const tempDb = openInMemoryBufferDb();

  try {
    const priors = options.priorCursors;
    if (priors) {
      for (const prior of priors) {
        tempDb
          .query(
            `INSERT INTO source_cursors (source_app, source_path_hash, source_path, source_inode, watermark_table, watermark_end, last_seen_size_bytes, last_seen_page_count, consecutive_errors, last_polled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceName,
            prior.sourcePathHash,
            prior.sourcePath,
            prior.sourceInode ?? 0,
            prior.watermarkTable ?? '',
            prior.watermarkEnd,
            prior.lastSeenSizeBytes,
            prior.lastSeenPageCount,
            prior.consecutiveErrors ?? 0,
            new Date().toISOString(),
          );
      }
    }

    let poller;
    const pollerOpts = options.baseDir !== undefined ? { baseDir: options.baseDir } : {};
    if (sourceName === 'claude-code') {
      const claudeCodeOpts: ClaudeCodeSourcePollerOptions = { ...pollerOpts };
      if (options.desktopCliSessionIds !== undefined) {
        claudeCodeOpts.desktopCliSessionIds = options.desktopCliSessionIds;
      }
      poller = makeClaudeCodeSourcePoller(claudeCodeOpts);
    } else if (sourceName === 'cursor') {
      poller = makeCursorSourcePoller(pollerOpts);
    } else if (sourceName === 'codex') {
      poller = makeCodexSourcePoller(pollerOpts);
    } else {
      throw new Error(`Unknown source poller: ${sourceName}`);
    }

    const ctx = {
      buffer: tempDb,
      gatewayVersion: options.gatewayVersion,
      maxDecompressedBytes: options.maxDecompressedBytes,
      minimumMtimeOverride: null,
      ...(options.excludedProjects !== undefined && { excludedProjects: options.excludedProjects }),
    };
    const outcome = await poller(ctx);

    interface BatchRow {
      capture_id: string;
      source_app: SourceApp;
      source_platform: SourcePlatform | null;
      source_kind: SourceKind;
      source_path: string;
      source_path_hash: string;
      source_inode: number | null;
      watermark_kind: WatermarkKind;
      watermark_start: number;
      watermark_end: number;
      watermark_table: string | null;
      agent_schema_version: string;
      gateway_version: string;
      captured_at_utc: string;
      body_format: BodyFormat;
      body_compression: BodyCompression;
      body: Uint8Array;
    }
    interface QuarantineRow {
      source_app: SourceApp;
      source_path: string;
      source_path_hash: string;
      source_inode: number | null;
      watermark_table: string | null;
      watermark_position: number;
      row_pk: string | null;
      redacted_size_bytes: number;
      reason: string;
      quarantined_at_utc: string;
      gateway_version: string;
    }
    interface CursorRow {
      source_path_hash: string;
      source_path: string;
      source_inode: number | null;
      watermark_table: string | null;
      watermark_end: number;
      last_seen_size_bytes: number | null;
      last_seen_page_count: number | null;
      consecutive_errors: number;
    }

    const batches = tempDb.query<BatchRow, []>('SELECT * FROM upload_batches').all();

    const quarantine = tempDb.query<QuarantineRow, []>('SELECT * FROM quarantined_records').all();

    const cursorRows = tempDb
      .query<CursorRow, [string]>(`SELECT * FROM source_cursors WHERE source_app = ?`)
      .all(sourceName);

    const cursors = cursorRows.map((cursorRow) => ({
      sourcePathHash: cursorRow.source_path_hash,
      sourcePath: cursorRow.source_path,
      sourceInode: cursorRow.source_inode,
      watermarkTable: cursorRow.watermark_table,
      watermarkEnd: cursorRow.watermark_end,
      lastSeenSizeBytes: cursorRow.last_seen_size_bytes,
      lastSeenPageCount: cursorRow.last_seen_page_count,
      consecutiveErrors: cursorRow.consecutive_errors,
    }));

    return {
      filesProcessed: outcome.filesProcessed,
      capturedBytes: outcome.capturedBytes,
      batches: batches.map((b) => ({
        captureId: b.capture_id,
        sourceApp: b.source_app,
        sourcePlatform: b.source_platform,
        sourceKind: b.source_kind,
        sourcePath: b.source_path,
        sourcePathHash: b.source_path_hash,
        sourceInode: b.source_inode,
        watermarkKind: b.watermark_kind,
        watermarkStart: b.watermark_start,
        watermarkEnd: b.watermark_end,
        watermarkTable: b.watermark_table,
        agentSchemaVersion: b.agent_schema_version,
        gatewayVersion: b.gateway_version,
        capturedAtUtc: b.captured_at_utc,
        bodyFormat: b.body_format,
        bodyCompression: b.body_compression,
        body: b.body,
      })),
      quarantine: quarantine.map((q) => ({
        sourceApp: q.source_app,
        sourcePath: q.source_path,
        sourcePathHash: q.source_path_hash,
        sourceInode: q.source_inode,
        watermarkTable: q.watermark_table,
        watermarkPosition: q.watermark_position,
        rowPk: q.row_pk,
        redactedSizeBytes: q.redacted_size_bytes,
        reason: q.reason,
        quarantinedAtUtc: q.quarantined_at_utc,
        gatewayVersion: q.gateway_version,
      })),
      cursors,
    };
  } finally {
    tempDb.close();
  }
}

export async function dispatchWorkerMessage(event: MessageEvent<WorkerInput>): Promise<void> {
  const worker = requireDefined(self);
  const { task, sourceName, options } = event.data;
  try {
    if (task === 'inspect') {
      worker.postMessage({
        sourceName,
        success: true,
        inspectResult: await handleInspect(sourceName, options),
      });
    } else if (task === 'capture') {
      worker.postMessage({
        sourceName,
        success: true,
        captureResult: await handleCapture(sourceName, options),
      });
    } else {
      throw new Error(`Unknown task: ${task}`);
    }
  } catch (err) {
    worker.postMessage({
      sourceName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerWorkerHandler(): void {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = dispatchWorkerMessage;
  }
}

registerWorkerHandler();
