import { nowIsoUtc } from 'core/utils';
import {
  checkPendingPressure,
  getMetadata,
  pruneBuffer,
  setDaemonState,
  setMetadata,
} from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type { DaemonStateSnapshot, PendingPressureResult, PruneResult } from 'services/buffer';
import { drainBuffer } from 'services/uploader';
import { isAuthFailed } from 'services/polling/auth-failed-sentinel.ts';
import {
  clearBufferFullSentinel,
  isBufferFull,
  writeBufferFullSentinel,
} from 'services/polling/buffer-full-sentinel.ts';
import { isPaused } from 'services/polling/pause-sentinel.ts';
import { checkStaleBinary } from 'services/polling/stale-binary.ts';
import {
  clearUpdateAvailableSentinel,
  writeUpdateAvailableSentinel,
} from 'services/polling/update-available-sentinel.ts';
import { checkLatestVersion } from 'services/polling/version-check.ts';
import type {
  PollCycleContext,
  PollCycleResult,
  SourcePollerContext,
  SourcePollerResult,
} from 'services/polling/polling.types.ts';
import { runAutoUpgrade } from 'services/upgrade';

export async function runPollCycle(ctx: PollCycleContext): Promise<PollCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  log?.info({ event: 'cycle.start', started_at: startedAt }, 'poll cycle started');

  if (await isAuthFailed(ctx.authFailedSentinelPath)) {
    const completedAt = nowIsoUtc();
    log?.warn({ event: 'cycle.auth_failed' }, 'poll cycle skipped: auth-failed sentinel present');
    return {
      paused: false,
      authFailed: true,
      bufferFull: false,
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
      pruneResult: null,
      pressureResult: null,
    };
  }

  if (await isBufferFull(ctx.bufferFullSentinelPath)) {
    const recovery = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (recovery.shouldResume) {
      await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
      log?.info(
        {
          event: 'buffer.soft_resume',
          pending_bytes: recovery.pendingBytes,
          threshold: ctx.bufferPolicy.softResumeBytes,
        },
        'buffer pending pressure dropped below resume threshold; sentinel cleared at cycle start',
      );
    } else {
      const completedAt = nowIsoUtc();
      log?.warn(
        {
          event: 'cycle.buffer_full',
          pending_bytes: recovery.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'poll cycle skipped: buffer-full sentinel present',
      );
      return {
        paused: false,
        authFailed: false,
        bufferFull: true,
        startedAt,
        completedAt,
        durationMs: Date.now() - startMs,
        sourceResults: {},
        drainResult: null,
        pruneResult: null,
        pressureResult: recovery,
      };
    }
  }

  const staleDeps: Parameters<typeof checkStaleBinary>[0] = {
    installedAt: ctx.installedAt,
    warnAfterDays: ctx.staleBinary.warnAfterDays,
    pauseAfterDays: ctx.staleBinary.pauseAfterDays,
    pauseSentinelPath: ctx.pauseSentinelPath,
  };
  if (log !== undefined) staleDeps.logger = log;
  await checkStaleBinary(staleDeps);

  if (await isPaused(ctx.pauseSentinelPath)) {
    const completedAt = nowIsoUtc();
    log?.info({ event: 'cycle.paused' }, 'poll cycle skipped: paused sentinel present');
    return {
      paused: true,
      authFailed: false,
      bufferFull: false,
      startedAt,
      completedAt,
      durationMs: Date.now() - startMs,
      sourceResults: {},
      drainResult: null,
      pruneResult: null,
      pressureResult: null,
    };
  }

  if (shouldRunAutoUpgrade(ctx)) {
    try {
      await maybeRunAutoUpgrade(ctx);
    } catch (err) {
      log?.warn(
        { event: 'version_check.failed', error: (err as Error).message ?? String(err) },
        'version check failed; continuing cycle',
      );
    }
  }

  const sourceResults: Record<string, SourcePollerResult> = {};
  for (const source of ctx.sources) {
    const sourceLog = log?.child({ source_app: source.name });
    sourceLog?.debug({ event: 'source.poll.start' }, 'source poll started');
    const sourceCtx: SourcePollerContext = {
      buffer: ctx.buffer,
      gatewayVersion: ctx.gatewayVersion,
      maxDecompressedBytes: ctx.capturePolicy.maxDecompressedBytes,
    };
    if (sourceLog !== undefined) sourceCtx.logger = sourceLog;
    if (ctx.minimumMtimeOverride !== undefined) {
      sourceCtx.minimumMtimeOverride = ctx.minimumMtimeOverride;
    }
    const result = await source.poll(sourceCtx);
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
      sourceLog?.warn(
        { event: 'source.poll.error', source_path: err.sourcePath, reason: err.reason },
        'source poll captured an error',
      );
    }
  }

  log?.debug({ event: 'drain.start' }, 'buffer drain started');
  const uploaderCtx: Parameters<typeof drainBuffer>[0] = {
    db: ctx.buffer,
    http: ctx.http,
    hostId: ctx.hostId,
    authFailedSentinelPath: ctx.authFailedSentinelPath,
  };
  if (log !== undefined) uploaderCtx.logger = log;
  if (ctx.pacer !== undefined) uploaderCtx.pacer = ctx.pacer;
  const drainResult = await drainBuffer(uploaderCtx);
  log?.info(
    {
      event: 'drain.complete',
      attempted: drainResult.attempted,
      accepted: drainResult.accepted,
      retriable: drainResult.retriable,
      fatal: drainResult.fatal,
      recovered: drainResult.recovered,
      retry_after_ms: drainResult.rateLimitedRetryAfterMs,
    },
    'buffer drain complete',
  );

  let pruneResult: PruneResult | null = null;
  try {
    const pruneInput: Parameters<typeof pruneBuffer>[0] = {
      db: ctx.buffer,
      receiptRetentionDays: ctx.bufferPolicy.receiptRetentionDays,
      failedRetentionDays: ctx.bufferPolicy.failedRetentionDays,
    };
    if (log !== undefined) pruneInput.logger = log;
    pruneResult = pruneBuffer(pruneInput);
  } catch (err) {
    log?.warn(
      { event: 'buffer.prune_failed', error: (err as Error).message ?? String(err) },
      'buffer prune failed; continuing cycle',
    );
  }

  let pressureResult: PendingPressureResult | null = null;
  try {
    pressureResult = checkPendingPressure({
      db: ctx.buffer,
      softPauseBytes: ctx.bufferPolicy.softPauseBytes,
      softResumeBytes: ctx.bufferPolicy.softResumeBytes,
    });
    if (pressureResult.shouldPause) {
      await writeBufferFullSentinel(ctx.bufferFullSentinelPath, {
        pendingBytes: pressureResult.pendingBytes,
        threshold: ctx.bufferPolicy.softPauseBytes,
      });
      log?.warn(
        {
          event: 'buffer.soft_pause',
          pending_bytes: pressureResult.pendingBytes,
          threshold: ctx.bufferPolicy.softPauseBytes,
        },
        'buffer pending pressure exceeded soft-pause threshold; sentinel written',
      );
    } else if (pressureResult.shouldResume) {
      const wasFull = await isBufferFull(ctx.bufferFullSentinelPath);
      if (wasFull) {
        await clearBufferFullSentinel(ctx.bufferFullSentinelPath);
        log?.info(
          {
            event: 'buffer.soft_resume',
            pending_bytes: pressureResult.pendingBytes,
            threshold: ctx.bufferPolicy.softResumeBytes,
          },
          'buffer pending pressure dropped below resume threshold; sentinel cleared',
        );
      }
    }
  } catch (err) {
    log?.warn(
      { event: 'buffer.pressure_failed', error: (err as Error).message ?? String(err) },
      'buffer pressure check failed; continuing cycle',
    );
  }

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    {
      event: 'cycle.complete',
      duration_ms: durationMs,
      completed_at: completedAt,
    },
    'poll cycle complete',
  );

  persistDaemonState(ctx, startedAt, completedAt, durationMs, sourceResults, drainResult);

  return {
    paused: false,
    authFailed: false,
    bufferFull: false,
    startedAt,
    completedAt,
    durationMs,
    sourceResults,
    drainResult,
    pruneResult,
    pressureResult,
  };
}

function persistDaemonState(
  ctx: PollCycleContext,
  startedAt: string,
  completedAt: string,
  durationMs: number,
  sourceResults: Record<string, SourcePollerResult>,
  drainResult: PollCycleResult['drainResult'],
): void {
  try {
    const sources: DaemonStateSnapshot['lastSourceCaptures'] = {};
    for (const [name, r] of Object.entries(sourceResults)) {
      sources[name] = {
        filesProcessed: r.filesProcessed,
        capturedBatches: r.capturedBatches,
        capturedBytes: r.capturedBytes,
        errorsCount: r.errors.length,
      };
    }
    const snapshot: DaemonStateSnapshot = {
      lastCycleStartedAt: startedAt,
      lastCycleCompletedAt: completedAt,
      lastCycleDurationMs: durationMs,
      lastDrainAttempted: drainResult?.attempted ?? null,
      lastDrainAccepted: drainResult?.accepted ?? null,
      lastDrainRetriable: drainResult?.retriable ?? null,
      lastDrainFatal: drainResult?.fatal ?? null,
      lastDrainRecovered: drainResult?.recovered ?? null,
      lastUploadError: drainResult?.lastUploadError ?? null,
      lastConsecutiveRetriableBreak: drainResult?.consecutiveRetriableBreak ?? null,
      lastSourceCaptures: sources,
    };
    setDaemonState(ctx.buffer, snapshot);
  } catch (err) {
    ctx.logger?.warn(
      { event: 'daemon_state.persist_failed', error: (err as Error).message ?? String(err) },
      'failed to persist daemon state',
    );
  }
}

const DEFAULT_VERSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function shouldRunAutoUpgrade(ctx: PollCycleContext): boolean {
  if (ctx.installSource === 'brew') {
    return ctx.updateAvailableSentinelPath !== undefined;
  }
  return ctx.binaryPath !== undefined && ctx.currentVersion !== undefined;
}

async function maybeRunAutoUpgrade(ctx: PollCycleContext): Promise<void> {
  const interval = ctx.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS;
  const lastCheck = getMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt);
  const lastMs = lastCheck === null ? 0 : Date.parse(lastCheck);
  if (lastCheck !== null && Number.isFinite(lastMs) && Date.now() - lastMs < interval) {
    return;
  }

  if (ctx.installSource === 'brew') {
    await runBrewSentinelCheck(ctx);
    setMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt, nowIsoUtc());
    return;
  }

  if (ctx.binaryPath === undefined || ctx.currentVersion === undefined) return;
  const autoDeps: Parameters<typeof runAutoUpgrade>[0] = {
    binaryPath: ctx.binaryPath,
    currentVersion: ctx.currentVersion,
  };
  if (ctx.devMode !== undefined) autoDeps.devMode = ctx.devMode;
  if (ctx.installSource !== undefined) autoDeps.installSource = ctx.installSource;
  if (ctx.versionCheckFetch !== undefined) autoDeps.fetch = ctx.versionCheckFetch;
  if (ctx.logger !== undefined) autoDeps.logger = ctx.logger;
  if (ctx.exitProcess !== undefined) autoDeps.exitProcess = ctx.exitProcess;
  await runAutoUpgrade(autoDeps);
  setMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt, nowIsoUtc());
}

async function runBrewSentinelCheck(ctx: PollCycleContext): Promise<void> {
  const sentinelPath = ctx.updateAvailableSentinelPath;
  if (sentinelPath === undefined) return;
  const log = ctx.logger;
  const fetchFn = ctx.versionCheckFetch ?? globalThis.fetch;
  const compareVersion = ctx.currentVersion ?? ctx.gatewayVersion;
  const outcome = await checkLatestVersion({
    currentVersion: compareVersion,
    fetch: fetchFn,
  });

  if (outcome.kind === 'no_release') {
    log?.debug(
      { event: 'version_check.no_release', reason: outcome.reason },
      'no published releases for gateway repo; skipping update sentinel',
    );
    return;
  }

  if (outcome.kind === 'error') {
    log?.warn(
      { event: 'version_check.unavailable', reason: outcome.reason },
      'version check failed; will retry next interval',
    );
    return;
  }

  const result = outcome.result;
  if (result.hasUpdate) {
    const sentinelInput: Parameters<typeof writeUpdateAvailableSentinel>[1] = {
      latest_version: result.latestVersion,
      current_version: compareVersion,
      detected_at: nowIsoUtc(),
    };
    if (result.assetUrl !== undefined) sentinelInput.asset_url = result.assetUrl;
    await writeUpdateAvailableSentinel(sentinelPath, sentinelInput);
    log?.info(
      { event: 'update_available', latest: result.latestVersion, current: compareVersion },
      'newer gateway version available',
    );
  } else {
    await clearUpdateAvailableSentinel(sentinelPath);
  }
}
