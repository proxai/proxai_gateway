import { Database } from 'bun:sqlite';
import { openInMemoryBufferDb } from 'services/buffer/db.ts';
import { makeClaudeCodeSourcePoller } from 'services/polling/poll-claude-code.ts';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';
import { makeCursorSourcePoller } from 'services/polling/poll-cursor.ts';
import { makeGeminiCliSourcePoller } from 'services/polling/poll-gemini-cli.ts';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';
import { discoverClaudeCodeFiles, defaultClaudeCodeProjectsRoot } from 'sources/claude-code';
import {
  discoverCodexRolloutFiles,
  discoverCodexStateSqlite,
  defaultCodexHome,
} from 'sources/codex';
import { discoverCursorFiles, defaultCursorUserRoot } from 'sources/cursor';
import { discoverGeminiCliFiles, defaultGeminiCliTmpRoot } from 'sources/gemini-cli';

declare const self: any;

async function countLinesAndOldestDate(
  filePath: string,
  start?: number,
  end?: number,
): Promise<{ count: number; oldestDate: string | null }> {
  let count = 0;
  let oldestDate: string | null = null;
  try {
    const file = Bun.file(filePath);
    const sliced = start !== undefined && end !== undefined ? file.slice(start, end) : file;
    const stream = sliced.stream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) {
          count++;
          if (oldestDate === null) {
            try {
              const parsed = JSON.parse(line);
              const ts = parsed.timestamp ?? parsed.created_at ?? parsed.time;
              if (ts && !isNaN(Date.parse(ts))) {
                oldestDate = new Date(ts).toISOString();
              }
            } catch {}
          }
        }
      }
    }
    if (partial.trim().length > 0) {
      count++;
      if (oldestDate === null) {
        try {
          const parsed = JSON.parse(partial);
          const ts = parsed.timestamp ?? parsed.created_at ?? parsed.time;
          if (ts && !isNaN(Date.parse(ts))) {
            oldestDate = new Date(ts).toISOString();
          }
        } catch {}
      }
    }
  } catch {}
  return { count, oldestDate };
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
  let oldestDateMs = Infinity;

  const updateOldest = (dateStr: string | null, fallbackMs: number) => {
    if (dateStr !== null) {
      const ms = Date.parse(dateStr);
      if (Number.isFinite(ms) && ms < oldestDateMs) {
        oldestDateMs = ms;
      }
    } else if (fallbackMs < oldestDateMs) {
      oldestDateMs = fallbackMs;
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
      const { count, oldestDate } = await countLinesAndOldestDate(f.sourcePath);
      recordCount += count;
      updateOldest(oldestDate, f.lastModifiedMs);

      telemetryRawBytes += f.sizeBytes;
      telemetryCompressedBytes += Math.round(f.sizeBytes / 6.0);
      telemetryRecordCount += count;
    }
  } else if (sourceName === 'cursor') {
    const baseDir = options.baseDir ?? defaultCursorUserRoot();
    const files = await discoverCursorFiles(baseDir, { minimumMtime: null });
    for (const f of files) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      updateOldest(null, f.lastModifiedMs);

      try {
        const db = new Database(f.sourcePath, { readonly: true });
        try {
          const tableCheck = db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
            .get();
          if (tableCheck !== null) {
            const prefixes = options.captureSubAgents
              ? ['composerData:', 'bubbleId:', 'agentKv:blob:', 'composer.content.']
              : ['composerData:', 'bubbleId:'];
            const clauses = prefixes.map((p) => `key LIKE '${p}%'`).join(' OR ');

            const countSql = 'SELECT COUNT(*) AS count FROM cursorDiskKV';
            const row = db.query<{ count: number }, []>(countSql).get();
            if (row !== null) {
              recordCount += row.count;
            }

            const telemetryCountSql = `SELECT COUNT(*) AS count FROM cursorDiskKV WHERE ${clauses}`;
            const telRow = db.query<{ count: number }, []>(telemetryCountSql).get();
            if (telRow !== null) {
              telemetryRecordCount += telRow.count;
            }

            const telemetryLengthSql = `SELECT SUM(LENGTH(value)) AS total_len FROM cursorDiskKV WHERE ${clauses}`;
            const telLenRow = db.query<{ total_len: number | null }, []>(telemetryLengthSql).get();
            if (telLenRow !== null && telLenRow.total_len !== null) {
              telemetryRawBytes += telLenRow.total_len;
              telemetryCompressedBytes += Math.round(telLenRow.total_len / 6.0);
            }
          }
        } finally {
          db.close();
        }
      } catch {}
    }
  } else if (sourceName === 'gemini-cli') {
    const baseDir = options.baseDir ?? defaultGeminiCliTmpRoot();
    const files = await discoverGeminiCliFiles(baseDir, { minimumMtime: null });
    for (const f of files) {
      filesProcessed++;
      totalBytes += f.sizeBytes;
      const { count, oldestDate } = await countLinesAndOldestDate(f.sourcePath);
      const adjustedCount = count > 1 ? count - 1 : count;
      recordCount += adjustedCount;
      updateOldest(oldestDate, f.lastModifiedMs);

      telemetryRawBytes += f.sizeBytes;
      telemetryCompressedBytes += Math.round(f.sizeBytes / 6.0);
      telemetryRecordCount += adjustedCount;
    }
  } else if (sourceName === 'codex') {
    const baseDir = options.baseDir ?? defaultCodexHome();

    try {
      const stateFile = await discoverCodexStateSqlite(baseDir, { minimumMtime: null });
      if (stateFile !== null) {
        filesProcessed++;
        totalBytes += stateFile.sizeBytes;
        updateOldest(null, stateFile.lastModifiedMs);

        const db = new Database(stateFile.sourcePath, { readonly: true });
        try {
          const tables = db
            .query<
              { name: string },
              []
            >("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all();
          for (const t of tables) {
            const row = db
              .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${t.name}"`)
              .get();
            if (row !== null) {
              recordCount += row.count;
            }
          }

          for (const tbl of ['threads', 'thread_dynamic_tools', 'thread_spawn_edges']) {
            const tableCheck = db
              .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tbl}'`)
              .get();
            if (tableCheck !== null) {
              const telRow = db
                .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM "${tbl}"`)
                .get();
              if (telRow !== null) {
                telemetryRecordCount += telRow.count;
              }

              const allRows = db.query<any, []>(`SELECT * FROM "${tbl}"`).all();
              let tblBytes = 0;
              for (const r of allRows) {
                tblBytes += Buffer.byteLength(JSON.stringify(r), 'utf8');
              }
              telemetryRawBytes += tblBytes;
              telemetryCompressedBytes += Math.round(tblBytes / 6.0);
            }
          }
        } finally {
          db.close();
        }
      }
    } catch {}

    try {
      const rolloutFiles = await discoverCodexRolloutFiles(baseDir, {
        minimumMtime: null,
        captureSubAgents: options.captureSubAgents,
      });
      for (const f of rolloutFiles) {
        filesProcessed++;
        totalBytes += f.sizeBytes;
        const { count, oldestDate } = await countLinesAndOldestDate(f.sourcePath);
        recordCount += count;
        updateOldest(oldestDate, f.lastModifiedMs);

        telemetryRawBytes += f.sizeBytes;
        telemetryCompressedBytes += Math.round(f.sizeBytes / 6.0);
        telemetryRecordCount += count;
      }
    } catch {}
  }

  return {
    filesProcessed,
    recordCount,
    telemetryRecordCount,
    totalBytes,
    telemetryRawBytes,
    telemetryCompressedBytes,
    oldestDate: oldestDateMs === Infinity ? null : new Date(oldestDateMs).toISOString(),
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
      poller = makeClaudeCodeSourcePoller(pollerOpts);
    } else if (sourceName === 'cursor') {
      poller = makeCursorSourcePoller(pollerOpts);
    } else if (sourceName === 'gemini-cli') {
      poller = makeGeminiCliSourcePoller(pollerOpts);
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
    };
    const outcome = await poller(ctx);

    const batches = tempDb.query<any, []>('SELECT * FROM upload_batches').all();

    const quarantine = tempDb.query<any, []>('SELECT * FROM quarantined_records').all();

    const cursorRows = tempDb
      .query<any, [string]>(`SELECT * FROM source_cursors WHERE source_app = ?`)
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

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async (event: MessageEvent<WorkerInput>) => {
    const { task, sourceName, options } = event.data;
    try {
      if (task === 'inspect') {
        const inspectResult = await handleInspect(sourceName, options);
        self.postMessage({
          sourceName,
          success: true,
          inspectResult,
        } as WorkerOutput);
      } else if (task === 'capture') {
        const captureResult = await handleCapture(sourceName, options);
        self.postMessage({
          sourceName,
          success: true,
          captureResult,
        } as WorkerOutput);
      } else {
        throw new Error(`Unknown task: ${task}`);
      }
    } catch (err) {
      self.postMessage({
        sourceName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as WorkerOutput);
    }
  };
}
