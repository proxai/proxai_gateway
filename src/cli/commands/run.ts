import { ensureDir } from 'core/io/fs';
import { dirname } from 'node:path';

import { createLogger, pruneLogDirectory } from 'core/log';
import type { Logger } from 'core/log';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { countCursors, openBufferDb } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import { buildDefaultSources, runPollLoop, syncServerWatermarks } from 'services/polling';
import type { PollCycleContext, PollCycleResult, RegisteredSource } from 'services/polling';
import { createPacer } from 'services/uploader';

export interface RunCommandDeps {
  output: OutputSink;
  config: GatewayConfig;
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  abortSignal: AbortSignal;
  gatewayVersion: string;
  sources?: readonly RegisteredSource[];
  onCycleComplete?: (result: PollCycleResult) => void;
  logger?: Logger;
  httpClient?: HttpClient;
}

export async function runDaemon(deps: RunCommandDeps): Promise<CommandResult> {
  await ensureDir(dirname(deps.config.capture.bufferPath));
  const buffer = openBufferDb(deps.config.capture.bufferPath);

  const logger =
    deps.logger ??
    (await createLogger({
      level: deps.config.logging.level,
      logDir: deps.config.logging.logDir,
      bindings: {
        service: 'proxai-gateway',
        version: deps.gatewayVersion,
        host_id: deps.config.account.hostId,
      },
    }));

  try {
    await pruneLogDirectory(deps.config.logging.logDir);
  } catch {
    // best-effort startup pruning; do not block daemon on retention errors
  }

  const http =
    deps.httpClient ??
    new HttpClient({
      apiKey: deps.config.account.apiKey,
      hostId: deps.config.account.hostId,
      endpoints: {
        ingest: deps.config.backend.ingestUrl,
        verifyKey: deps.config.backend.verifyKeyUrl,
        watermarks: deps.config.backend.watermarksUrl,
      },
      gatewayVersion: deps.gatewayVersion,
    });

  logger.info(
    {
      event: 'daemon.start',
      poll_interval_sec: deps.config.capture.pollIntervalSec,
      buffer_path: deps.config.capture.bufferPath,
    },
    'daemon starting',
  );

  // Pre-flight watermark sync. When the cursor table is empty (typical after
  // a fresh install or buffer wipe), pull server-known positions to suppress
  // duplicate captures from byte 0. Failures are logged but do not abort the
  // daemon — the runtime regression-recovery path acts as a safety net.
  if (countCursors(buffer) === 0) {
    logger.info(
      { event: 'watermark_sync.start', reason: 'fresh_buffer' },
      'syncing watermarks from server',
    );
    try {
      const syncResult = await syncServerWatermarks({ buffer, http, logger });
      logger.info(
        {
          event: 'watermark_sync.complete',
          fetched: syncResult.fetched,
          applied: syncResult.applied,
          skipped: syncResult.skipped,
        },
        'watermark sync complete',
      );
    } catch (err) {
      logger.warn(
        { event: 'watermark_sync.failed', error: (err as Error).message ?? String(err) },
        'watermark sync failed; capture will start from zero',
      );
    }
  }

  try {
    deps.output.info(
      `starting poll loop (interval: ${deps.config.capture.pollIntervalSec.toString()}s)`,
    );
    const loopOptions: {
      intervalMs: number;
      abortSignal: AbortSignal;
      onCycleComplete?: (result: PollCycleResult) => void;
    } = {
      intervalMs: deps.config.capture.pollIntervalSec * 1000,
      abortSignal: deps.abortSignal,
    };
    if (deps.onCycleComplete !== undefined) loopOptions.onCycleComplete = deps.onCycleComplete;
    // Per-daemon pacer: rate-limit state must accumulate across drain calls so
    // a sustained 429 streak applies the right backoff regardless of where in
    // the poll cycle the throttling started.
    const pacer = createPacer({
      maxBatchesPerSec: deps.config.capture.uploadMaxBatchesPerSec,
      maxBytesPerMinute: deps.config.capture.uploadMaxBytesPerMinute,
      backoffMultiplier: deps.config.capture.uploadBackoffOn429Multiplier,
    });
    const cycleCtx: PollCycleContext = {
      buffer,
      http,
      hostId: deps.config.account.hostId,
      gatewayVersion: deps.gatewayVersion,
      sources:
        deps.sources ??
        buildDefaultSources({
          initialScanWindowDays: deps.config.capture.initialScanWindowDays,
        }),
      pauseSentinelPath: deps.pauseSentinelPath,
      authFailedSentinelPath: deps.authFailedSentinelPath,
      bufferFullSentinelPath: deps.bufferFullSentinelPath,
      installedAt: deps.config.account.installedAt,
      staleBinary: {
        warnAfterDays: deps.config.staleBinary.warnAfterDays,
        pauseAfterDays: deps.config.staleBinary.pauseAfterDays,
      },
      bufferPolicy: {
        receiptRetentionDays: deps.config.capture.receiptRetentionDays,
        failedRetentionDays: deps.config.capture.failedRetentionDays,
        softPauseBytes: deps.config.capture.bufferSoftPauseBytes,
        softResumeBytes: deps.config.capture.bufferSoftResumeBytes,
      },
      capturePolicy: {
        initialScanWindowDays: deps.config.capture.initialScanWindowDays,
      },
      pacer,
      logger,
    };
    await runPollLoop(cycleCtx, loopOptions);
  } finally {
    logger.info({ event: 'daemon.stop' }, 'daemon shutting down');
    buffer.close();
  }

  deps.output.info('poll loop exited');
  return { exitCode: EXIT_CODE.ok };
}
