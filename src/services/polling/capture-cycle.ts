import { nowIsoUtc } from 'core/utils';
import {
  checkPendingPressure,
  getDaemonState,
  getMetadata,
  setDaemonState,
  setMetadata,
  insertBatch,
  recordQuarantine,
  setCursor,
} from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type {
  DaemonStateSnapshot,
  PendingPressureResult,
  SourceCycleResult,
} from 'services/buffer';
import type { SourceApp } from 'services/contract';
import { VALID_SOURCE_APPS } from 'services/contract';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import { isBufferFull, writeBufferFullSentinel } from 'services/polling/buffer-full-sentinel.ts';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import { handleCapture } from 'services/polling/poll-worker.ts';

import type {
  CaptureCycleContext,
  CaptureCycleResult,
  SourcePollerContext,
  SourcePollerResult,
  RegisteredSource,
} from 'services/polling/polling.types.ts';

// Raw row shape for `SELECT * FROM source_cursors`. Mirrors the snake_case
// columns declared in services/buffer/buffer.constants.ts.
interface SourceCursorRow {
  source_app: string;
  source_path_hash: string;
  source_path: string;
  source_inode: number | null;
  watermark_table: string | null;
  watermark_end: number;
  last_polled_at: string;
  consecutive_errors: number;
  last_seen_size_bytes: number | null;
  last_seen_page_count: number | null;
}

// Why: RegisteredSource.name is typed as `string` so the registry can hold
// arbitrary identifiers, but the buffer-insert APIs expect the closed
// `SourceApp` union. Narrow once here so capture-cycle never reaches for an
// `as any` cast when wiring the worker output back into buffer storage.
function assertSourceApp(name: string): SourceApp {
  if ((VALID_SOURCE_APPS as readonly string[]).includes(name)) {
    return name as SourceApp;
  }
  throw new Error(`Unknown source app: ${name}`);
}

export async function runCaptureCycle(ctx: CaptureCycleContext): Promise<CaptureCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  log?.info({ event: 'capture.cycle.start', started_at: startedAt }, 'capture cycle started');

  if (await isAuthFailed(ctx.authFailedSentinelPath)) {
    return finishSkip(startedAt, startMs, 'auth_failed', log, {
      authFailed: true,
      paused: false,
      bufferFull: false,
    });
  }
  if (await isPaused(ctx.pauseSentinelPath)) {
    return finishSkip(startedAt, startMs, 'paused', log, {
      authFailed: false,
      paused: true,
      bufferFull: false,
    });
  }
  if (await isBufferFull(ctx.bufferFullSentinelPath)) {
    return finishSkip(startedAt, startMs, 'buffer_full', log, {
      authFailed: false,
      paused: false,
      bufferFull: true,
    });
  }

  const sourceResults: Record<string, SourcePollerResult> = {};
  const promises = ctx.sources.map(async (source) => {
    const sourceLog = log?.child({ source_app: source.name });
    sourceLog?.debug({ event: 'source.poll.start' }, 'source poll started');

    const isDefaultSource = ['claude-code', 'cursor', 'gemini-cli', 'codex'].includes(source.name);

    let result: SourcePollerResult;
    if (isDefaultSource) {
      result = await pollSourceInWorker(source, ctx);
    } else {
      const sourceCtx: SourcePollerContext = {
        buffer: ctx.buffer,
        gatewayVersion: ctx.gatewayVersion,
        maxDecompressedBytes: ctx.capturePolicy.maxDecompressedBytes,
      };
      if (sourceLog !== undefined) sourceCtx.logger = sourceLog;
      if (ctx.minimumMtimeOverride !== undefined) {
        sourceCtx.minimumMtimeOverride = ctx.minimumMtimeOverride;
      }
      result = await source.poll(sourceCtx);
    }

    sourceResults[source.name] = result;
    sourceLog?.info(
      {
        event: 'source.poll.complete',
        files_processed: result.filesProcessed,
        captured_batches: result.capturedBatches,
        captured_bytes: result.capturedBytes,
        errors_count: result.errors.length,
      },
      'source poll complete',
    );
    for (const err of result.errors) {
      sourceLog?.error(
        { event: 'source.poll.error', source_path: err.sourcePath, reason: err.reason },
        'source poll captured an error',
      );
    }
  });

  await Promise.all(promises);

  const pressureResult = await applyPressureSentinel(ctx, log);

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'capture.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'capture cycle complete',
  );

  persistCaptureMetrics(ctx, completedAt, durationMs, sourceResults);
  persistSourceCaptures(ctx, sourceResults);

  return {
    paused: false,
    authFailed: false,
    bufferFull: false,
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    pressureResult,
  };
}

function toSourceCycleResult(result: SourcePollerResult): SourceCycleResult {
  return {
    filesProcessed: result.filesProcessed,
    capturedBatches: result.capturedBatches,
    capturedBytes: result.capturedBytes,
    errorsCount: result.errors.length,
  };
}

function persistSourceCaptures(
  ctx: CaptureCycleContext,
  sourceResults: Record<string, SourcePollerResult>,
): void {
  try {
    const existing = getDaemonState(ctx.buffer);
    const captures: Record<string, SourceCycleResult> = {
      ...existing?.lastSourceCaptures,
    };
    for (const [name, result] of Object.entries(sourceResults)) {
      captures[name] = toSourceCycleResult(result);
    }
    const snapshot: DaemonStateSnapshot = {
      lastCycleStartedAt: existing?.lastCycleStartedAt ?? null,
      lastCycleCompletedAt: existing?.lastCycleCompletedAt ?? null,
      lastCycleDurationMs: existing?.lastCycleDurationMs ?? null,
      lastDrainAttempted: existing?.lastDrainAttempted ?? null,
      lastDrainAccepted: existing?.lastDrainAccepted ?? null,
      lastDrainRetriable: existing?.lastDrainRetriable ?? null,
      lastDrainFatal: existing?.lastDrainFatal ?? null,
      lastDrainRecovered: existing?.lastDrainRecovered ?? null,
      lastUploadError: existing?.lastUploadError ?? null,
      lastConsecutiveRetriableBreak: existing?.lastConsecutiveRetriableBreak ?? null,
      lastSourceCaptures: captures,
    };
    setDaemonState(ctx.buffer, snapshot);
  } catch (err) {
    ctx.logger?.warn(
      { event: 'daemon_state.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist daemon state from capture cycle',
    );
  }
}

async function applyPressureSentinel(
  ctx: CaptureCycleContext,
  log: CaptureCycleContext['logger'],
): Promise<PendingPressureResult | null> {
  try {
    const result = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (result.shouldPause) {
      await writeBufferFullSentinel(ctx.bufferFullSentinelPath, {
        pendingBytes: result.pendingBytes,
        threshold: ctx.bufferPolicy.softPauseBytes,
      });
      log?.warn(
        {
          event: 'buffer.soft_pause',
          pending_bytes: result.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'buffer pending pressure exceeded soft-pause threshold; sentinel written',
      );
    }
    return result;
  } catch (err) {
    log?.warn(
      { event: 'buffer.pressure_failed', error: (err as Error).message ?? String(err) },
      'buffer pressure check failed; continuing capture',
    );
    return null;
  }
}

function persistCaptureMetrics(
  ctx: CaptureCycleContext,
  completedAt: string,
  durationMs: number,
  sourceResults: Record<string, SourcePollerResult>,
): void {
  try {
    const total = readNumberMetadata(ctx.buffer, METADATA_KEYS.captureCyclesTotal) + 1;
    setMetadata(ctx.buffer, METADATA_KEYS.captureCyclesTotal, total.toString());
    setMetadata(ctx.buffer, METADATA_KEYS.captureLastCycleAt, completedAt);
    setMetadata(ctx.buffer, METADATA_KEYS.captureLastCycleDurationMs, durationMs.toString());
    const hadErrors = Object.values(sourceResults).some((r) => r.errors.length > 0);
    if (hadErrors) {
      const errs = readNumberMetadata(ctx.buffer, METADATA_KEYS.captureCyclesWithErrors) + 1;
      setMetadata(ctx.buffer, METADATA_KEYS.captureCyclesWithErrors, errs.toString());
    }
  } catch (err) {
    ctx.logger?.warn(
      { event: 'metrics.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist capture metrics',
    );
  }
}

function readNumberMetadata(buffer: CaptureCycleContext['buffer'], key: string): number {
  const raw = getMetadata(buffer, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function finishSkip(
  startedAt: string,
  startMs: number,
  reason: 'auth_failed' | 'paused' | 'buffer_full',
  log: CaptureCycleContext['logger'],
  flags: { paused: boolean; authFailed: boolean; bufferFull: boolean },
): CaptureCycleResult {
  const completedAt = nowIsoUtc();
  log?.info(
    { event: 'capture.cycle.skipped', reason },
    `capture cycle skipped: ${reason} sentinel present`,
  );
  return {
    paused: flags.paused,
    authFailed: flags.authFailed,
    bufferFull: flags.bufferFull,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    sourceResults: {},
    pressureResult: null,
  };
}

async function pollSourceInWorker(
  source: RegisteredSource,
  ctx: CaptureCycleContext,
): Promise<SourcePollerResult> {
  try {
    const cursorRows = ctx.buffer
      .query<SourceCursorRow, [string]>('SELECT * FROM source_cursors WHERE source_app = ?')
      .all(source.name);

    const priorCursors = cursorRows.map((c) => ({
      sourcePathHash: c.source_path_hash,
      sourcePath: c.source_path,
      sourceInode: c.source_inode,
      watermarkTable: c.watermark_table,
      watermarkEnd: c.watermark_end,
      lastSeenSizeBytes: c.last_seen_size_bytes,
      lastSeenPageCount: c.last_seen_page_count,
      consecutiveErrors: c.consecutive_errors,
    }));

    const isCompiled = import.meta.url.includes('$bunfs') || import.meta.url.includes('bun:wrap');
    if (isCompiled) {
      const optionsObj: WorkerInput['options'] = {
        gatewayVersion: ctx.gatewayVersion,
        maxDecompressedBytes: ctx.capturePolicy.maxDecompressedBytes,
        captureSubAgents: true,
        priorCursors,
      };
      if (source.baseDir !== undefined) {
        optionsObj.baseDir = source.baseDir;
      }
      const capture = await handleCapture(source.name, optionsObj);
      if (!capture) {
        return {
          filesProcessed: 0,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [],
        };
      }

      try {
        ctx.buffer.transaction(() => {
          for (const b of capture.batches) {
            insertBatch(ctx.buffer, b);
          }

          for (const q of capture.quarantine) {
            recordQuarantine(ctx.buffer, q);
          }

          const sourceApp = assertSourceApp(source.name);
          for (const c of capture.cursors) {
            setCursor(ctx.buffer, {
              sourceApp,
              sourcePathHash: c.sourcePathHash,
              sourcePath: c.sourcePath,
              sourceInode: c.sourceInode,
              watermarkTable: c.watermarkTable,
              watermarkEnd: c.watermarkEnd,
              lastSeenSizeBytes: c.lastSeenSizeBytes,
              lastSeenPageCount: c.lastSeenPageCount,
              consecutiveErrors: c.consecutiveErrors,
            });
          }
        })();
      } catch (dbErr) {
        return {
          filesProcessed: capture.filesProcessed,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [
            {
              sourcePath: source.baseDir ?? source.name,
              reason: dbErr instanceof Error ? dbErr.message : String(dbErr),
            },
          ],
        };
      }

      return {
        filesProcessed: capture.filesProcessed,
        capturedBatches: capture.batches.length,
        capturedBytes: capture.capturedBytes,
        errors: [],
      };
    }

    return new Promise<SourcePollerResult>((resolve) => {
      try {
        const workerUrl = new URL('./poll-worker.ts', import.meta.url).href;
        const worker = new Worker(workerUrl, { type: 'module' });

        worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
          const output = event.data;
          worker.terminate();

          if (!output.success) {
            resolve({
              filesProcessed: 0,
              capturedBatches: 0,
              capturedBytes: 0,
              errors: [
                {
                  sourcePath: source.baseDir ?? source.name,
                  reason: output.error ?? 'Worker failed',
                },
              ],
            });
            return;
          }

          const capture = output.captureResult;
          if (!capture) {
            resolve({
              filesProcessed: 0,
              capturedBatches: 0,
              capturedBytes: 0,
              errors: [],
            });
            return;
          }

          try {
            ctx.buffer.transaction(() => {
              for (const b of capture.batches) {
                insertBatch(ctx.buffer, b);
              }

              for (const q of capture.quarantine) {
                recordQuarantine(ctx.buffer, q);
              }

              const sourceApp = assertSourceApp(source.name);
              for (const c of capture.cursors) {
                setCursor(ctx.buffer, {
                  sourceApp,
                  sourcePathHash: c.sourcePathHash,
                  sourcePath: c.sourcePath,
                  sourceInode: c.sourceInode,
                  watermarkTable: c.watermarkTable,
                  watermarkEnd: c.watermarkEnd,
                  lastSeenSizeBytes: c.lastSeenSizeBytes,
                  lastSeenPageCount: c.lastSeenPageCount,
                  consecutiveErrors: c.consecutiveErrors,
                });
              }
            })();
          } catch (dbErr) {
            resolve({
              filesProcessed: capture.filesProcessed,
              capturedBatches: 0,
              capturedBytes: 0,
              errors: [
                {
                  sourcePath: source.baseDir ?? source.name,
                  reason: dbErr instanceof Error ? dbErr.message : String(dbErr),
                },
              ],
            });
            return;
          }

          resolve({
            filesProcessed: capture.filesProcessed,
            capturedBatches: capture.batches.length,
            capturedBytes: capture.capturedBytes,
            errors: [],
          });
        };

        worker.onerror = (err) => {
          worker.terminate();
          resolve({
            filesProcessed: 0,
            capturedBatches: 0,
            capturedBytes: 0,
            errors: [
              {
                sourcePath: source.baseDir ?? source.name,
                reason: err.message || 'Worker syntax/runtime error',
              },
            ],
          });
        };

        const optionsObj: WorkerInput['options'] = {
          gatewayVersion: ctx.gatewayVersion,
          maxDecompressedBytes: ctx.capturePolicy.maxDecompressedBytes,
          captureSubAgents: true,
          priorCursors,
        };
        if (source.baseDir !== undefined) {
          optionsObj.baseDir = source.baseDir;
        }

        const workerInput: WorkerInput = {
          task: 'capture',
          sourceName: source.name,
          options: optionsObj,
        };
        worker.postMessage(workerInput);
      } catch (e) {
        resolve({
          filesProcessed: 0,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [
            {
              sourcePath: source.baseDir ?? source.name,
              reason: e instanceof Error ? e.message : String(e),
            },
          ],
        });
      }
    });
  } catch (e) {
    return {
      filesProcessed: 0,
      capturedBatches: 0,
      capturedBytes: 0,
      errors: [
        {
          sourcePath: source.baseDir ?? source.name,
          reason: e instanceof Error ? e.message : String(e),
        },
      ],
    };
  }
}
