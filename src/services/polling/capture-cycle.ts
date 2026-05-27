import { createActor, type Actor } from 'xstate';
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
import { handleCapture } from 'services/polling/poll-worker.ts';
import {
  captureLoopMachine,
  type CaptureGateBlockReason,
} from 'services/state-machines/capture-loop';
import {
  cursorLifecycleMachine,
  type CursorIdentity,
  type CursorLifecycleMachine,
} from 'services/state-machines/cursor-lifecycle';
import {
  quarantineLifecycleMachine,
  type QuarantinedRecord,
} from 'services/state-machines/quarantine-lifecycle';
import { sourcePollMachine, type SourcePollMachine } from 'services/state-machines/source-poll';
import { workerMachine, type WorkerMachine } from 'services/state-machines/worker';

import type {
  CaptureCycleContext,
  CaptureCycleResult,
  SourcePollerContext,
  SourcePollerResult,
  RegisteredSource,
} from 'services/polling/polling.types.ts';

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

function assertSourceApp(name: string): SourceApp {
  if ((VALID_SOURCE_APPS as readonly string[]).includes(name)) {
    return name as SourceApp;
  }
  throw new Error(`Unknown source app: ${name}`);
}

function tryStartPollActor(name: string): Actor<SourcePollMachine> | null {
  if (!(VALID_SOURCE_APPS as readonly string[]).includes(name)) return null;
  const actor = createActor(sourcePollMachine, { input: { sourceApp: name as SourceApp } });
  actor.start();
  return actor;
}

function trackCursor(
  identity: CursorIdentity,
  outcome: {
    watermarkEnd: number;
    lastSeenSizeBytes: number | null;
    lastSeenPageCount: number | null;
  } | null,
  polledAtUtc: string,
): Actor<CursorLifecycleMachine> {
  const cursor = createActor(cursorLifecycleMachine, { input: { identity } });
  cursor.start();
  if (outcome === null) {
    cursor.send({ type: 'POLL_ERROR', polledAtUtc });
  } else {
    cursor.send({
      type: 'POLL_SUCCESS',
      watermarkEnd: outcome.watermarkEnd,
      polledAtUtc,
      lastSeenSizeBytes: outcome.lastSeenSizeBytes,
      lastSeenPageCount: outcome.lastSeenPageCount,
    });
  }
  cursor.stop();
  return cursor;
}

function trackQuarantine(record: QuarantinedRecord): void {
  const actor = createActor(quarantineLifecycleMachine, { input: { record } });
  actor.start();
  actor.stop();
}

export async function runCaptureCycle(ctx: CaptureCycleContext): Promise<CaptureCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  const cycleMachine = createActor(captureLoopMachine, { input: { intervalMs: 0 } });
  cycleMachine.start();
  cycleMachine.send({ type: 'TICK', startedAtUtc: startedAt });

  log?.info({ event: 'capture.cycle.start', started_at: startedAt }, 'capture cycle started');

  const gateReason = await evaluateGateReason(ctx);
  if (gateReason !== null) {
    cycleMachine.send({ type: 'GATE_BLOCKED', reason: gateReason });
    const result = finishSkip(startedAt, startMs, gateReasonToSkipKey(gateReason), log, {
      authFailed: gateReason === 'auth',
      bufferFull: gateReason === 'buffer_full',
    });
    cycleMachine.send({
      type: 'METRICS_PERSISTED',
      finishedAtUtc: result.completedAt,
      durationMs: result.durationMs,
    });
    cycleMachine.stop();
    return result;
  }

  cycleMachine.send({ type: 'GATE_CLEAR' });

  const sourceResults: Record<string, SourcePollerResult> = {};
  const promises = ctx.sources.map(async (source) => {
    const sourceLog = log?.child({ source_app: source.name });
    sourceLog?.debug({ event: 'source.poll.start' }, 'source poll started');

    const pollActor = tryStartPollActor(source.name);
    if (pollActor !== null) {
      pollActor.send({ type: 'BEGIN_POLL', startedAtUtc: nowIsoUtc() });
    }

    const isDefaultSource = ['claude-code', 'cursor', 'gemini-cli', 'codex'].includes(source.name);

    let result: SourcePollerResult;
    if (isDefaultSource) {
      result = await pollSourceInWorker(source, ctx, pollActor);
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

    if (pollActor !== null) {
      if (result.filesProcessed > 0) {
        pollActor.send({ type: 'FILES_FOUND', count: result.filesProcessed });
        for (let i = 0; i < result.filesProcessed; i += 1) {
          pollActor.send({
            type: 'FILE_PROCESSED',
            batchesEmitted: i === 0 ? result.capturedBatches : 0,
            quarantineEmitted: i === 0 ? result.errors.length : 0,
            cursorUpdates: i === 0 ? result.filesProcessed : 0,
          });
        }
        pollActor.send({ type: 'ALL_FILES_PROCESSED' });
      } else if (result.errors.length > 0) {
        pollActor.send({ type: 'DISCOVERY_ERROR', message: result.errors[0]?.reason ?? 'unknown' });
      } else {
        pollActor.send({ type: 'NO_FILES' });
      }
      pollActor.send({ type: 'EMIT_COMPLETE', finishedAtUtc: nowIsoUtc() });
      pollActor.stop();
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

  const totalBatches = Object.values(sourceResults).reduce((sum, r) => sum + r.capturedBatches, 0);
  const totalQuarantine = Object.values(sourceResults).reduce((sum, r) => sum + r.errors.length, 0);
  cycleMachine.send({
    type: 'POLL_COMPLETE',
    batchesEmitted: totalBatches,
    quarantineEmitted: totalQuarantine,
  });
  cycleMachine.send({ type: 'COMMITTED' });

  const pressureResult = await applyPressureSentinel(ctx, log);
  cycleMachine.send({
    type: 'PRESSURE_EVALUATED',
    pendingBytes: pressureResult?.pendingBytes ?? 0,
    shouldPause: pressureResult?.shouldPause ?? false,
  });

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'capture.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'capture cycle complete',
  );

  persistCaptureMetrics(ctx, completedAt, durationMs, sourceResults);
  persistSourceCaptures(ctx, sourceResults);
  cycleMachine.send({
    type: 'METRICS_PERSISTED',
    finishedAtUtc: completedAt,
    durationMs,
  });
  cycleMachine.stop();

  return {
    authFailed: false,
    bufferFull: false,
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    pressureResult,
  };
}

async function evaluateGateReason(
  ctx: CaptureCycleContext,
): Promise<CaptureGateBlockReason | null> {
  if (await isAuthFailed(ctx.authFailedSentinelPath)) return 'auth';
  if (await isBufferFull(ctx.bufferFullSentinelPath)) return 'buffer_full';
  return null;
}

function gateReasonToSkipKey(reason: CaptureGateBlockReason): 'auth_failed' | 'buffer_full' {
  if (reason === 'auth') return 'auth_failed';
  return reason;
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
  reason: 'auth_failed' | 'buffer_full',
  log: CaptureCycleContext['logger'],
  flags: { authFailed: boolean; bufferFull: boolean },
): CaptureCycleResult {
  const completedAt = nowIsoUtc();
  log?.info(
    { event: 'capture.cycle.skipped', reason },
    `capture cycle skipped: ${reason} sentinel present`,
  );
  return {
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
  pollActor: Actor<SourcePollMachine> | null,
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
      return runInProcessWorker(source, ctx, priorCursors, pollActor);
    }
    return runThreadedWorker(source, ctx, priorCursors, pollActor);
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

type PriorCursors = NonNullable<WorkerInput['options']['priorCursors']>;

async function runInProcessWorker(
  source: RegisteredSource,
  ctx: CaptureCycleContext,
  priorCursors: PriorCursors,
  pollActor: Actor<SourcePollMachine> | null,
): Promise<SourcePollerResult> {
  const sourceApp = assertSourceApp(source.name);
  const workerActor = createActor(workerMachine, {
    input: { sourceApp, workerId: `${source.name}-${Date.now().toString()}` },
  });
  workerActor.start();
  const workerStartedAt = nowIsoUtc();
  workerActor.send({ type: 'BEGIN_RUN', startedAtUtc: workerStartedAt });

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
    workerActor.send({
      type: 'RESULT_POSTED',
      result: { batchCount: 0, quarantineCount: 0, cursorCount: 0 },
      finishedAtUtc: nowIsoUtc(),
    });
    workerActor.send({ type: 'TERMINATE' });
    workerActor.stop();
    return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
  }

  return commitWorkerCapture(source, ctx, capture, pollActor, workerActor);
}

function runThreadedWorker(
  source: RegisteredSource,
  ctx: CaptureCycleContext,
  priorCursors: PriorCursors,
  pollActor: Actor<SourcePollMachine> | null,
): Promise<SourcePollerResult> {
  return new Promise<SourcePollerResult>((resolve) => {
    try {
      const sourceApp = assertSourceApp(source.name);
      const workerActor = createActor(workerMachine, {
        input: { sourceApp, workerId: `${source.name}-${Date.now().toString()}` },
      });
      workerActor.start();
      workerActor.send({ type: 'BEGIN_RUN', startedAtUtc: nowIsoUtc() });

      const workerUrl = new URL('./poll-worker.ts', import.meta.url).href;
      const worker = new Worker(workerUrl, { type: 'module' });

      worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
        const output = event.data;
        worker.terminate();

        if (!output.success) {
          const errMsg = output.error ?? 'Worker failed';
          workerActor.send({ type: 'ERROR', message: errMsg, finishedAtUtc: nowIsoUtc() });
          workerActor.send({ type: 'TERMINATE' });
          workerActor.stop();
          resolve({
            filesProcessed: 0,
            capturedBatches: 0,
            capturedBytes: 0,
            errors: [{ sourcePath: source.baseDir ?? source.name, reason: errMsg }],
          });
          return;
        }

        const capture = output.captureResult;
        if (!capture) {
          workerActor.send({
            type: 'RESULT_POSTED',
            result: { batchCount: 0, quarantineCount: 0, cursorCount: 0 },
            finishedAtUtc: nowIsoUtc(),
          });
          workerActor.send({ type: 'TERMINATE' });
          workerActor.stop();
          resolve({ filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] });
          return;
        }

        commitWorkerCapture(source, ctx, capture, pollActor, workerActor).then(resolve);
      };

      worker.onerror = (err) => {
        worker.terminate();
        workerActor.send({
          type: 'ERROR',
          message: err.message || 'Worker syntax/runtime error',
          finishedAtUtc: nowIsoUtc(),
        });
        workerActor.send({ type: 'TERMINATE' });
        workerActor.stop();
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
}

type CaptureBundle = NonNullable<Awaited<ReturnType<typeof handleCapture>>>;

async function commitWorkerCapture(
  source: RegisteredSource,
  ctx: CaptureCycleContext,
  capture: CaptureBundle,
  pollActor: Actor<SourcePollMachine> | null,
  workerActor: Actor<WorkerMachine>,
): Promise<SourcePollerResult> {
  const sourceApp = assertSourceApp(source.name);
  try {
    ctx.buffer.transaction(() => {
      for (const b of capture.batches) {
        insertBatch(ctx.buffer, b);
      }
      for (const q of capture.quarantine) {
        recordQuarantine(ctx.buffer, q);
        trackQuarantine({
          sourceApp: assertSourceApp(q.sourceApp),
          sourcePathHash: q.sourcePathHash,
          watermarkTable: q.watermarkTable,
          watermarkPosition: q.watermarkPosition,
          redactedSizeBytes: q.redactedSizeBytes,
          reason: q.reason,
          quarantinedAtUtc: q.quarantinedAtUtc,
          gatewayVersion: q.gatewayVersion,
        });
      }
      const polledAtUtc = nowIsoUtc();
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
        trackCursor(
          {
            sourceApp,
            sourcePathHash: c.sourcePathHash,
            sourceInode: c.sourceInode,
            watermarkTable: c.watermarkTable,
          },
          c.consecutiveErrors > 0
            ? null
            : {
                watermarkEnd: c.watermarkEnd,
                lastSeenSizeBytes: c.lastSeenSizeBytes,
                lastSeenPageCount: c.lastSeenPageCount,
              },
          polledAtUtc,
        );
      }
    })();
    workerActor.send({
      type: 'RESULT_POSTED',
      result: {
        batchCount: capture.batches.length,
        quarantineCount: capture.quarantine.length,
        cursorCount: capture.cursors.length,
      },
      finishedAtUtc: nowIsoUtc(),
    });
    workerActor.send({ type: 'TERMINATE' });
    workerActor.stop();
    void pollActor;
    return {
      filesProcessed: capture.filesProcessed,
      capturedBatches: capture.batches.length,
      capturedBytes: capture.capturedBytes,
      errors: [],
    };
  } catch (dbErr) {
    workerActor.send({
      type: 'ERROR',
      message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      finishedAtUtc: nowIsoUtc(),
    });
    workerActor.send({ type: 'TERMINATE' });
    workerActor.stop();
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
}
