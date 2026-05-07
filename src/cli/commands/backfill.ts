import { ensureDir } from 'core/io/fs';
import { dirname } from 'node:path';

import { createLogger } from 'core/log';
import type { Logger } from 'core/log';
import { parseBackfillDuration } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { countCursors, openBufferDb } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import { buildDefaultSources, runPollCycle, syncServerWatermarks } from 'services/polling';
import type { PollCycleContext, PollCycleResult, RegisteredSource } from 'services/polling';
import { createPacer } from 'services/uploader';

export interface BackfillCommandDeps {
  output: OutputSink;
  config: GatewayConfig;
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  gatewayVersion: string;

  sources?: readonly RegisteredSource[];
  logger?: Logger;
  httpClient?: HttpClient;

  isDaemonRunning?: () => Promise<boolean>;
}

export interface BackfillCommandOptions {
  since: string;
}

export async function runBackfill(
  deps: BackfillCommandDeps,
  options: BackfillCommandOptions,
): Promise<CommandResult> {
  const durationMs = parseBackfillDuration(options.since);
  if (durationMs === null) {
    deps.output.error(
      'invalid --since duration; use Nd (days), Nmo (months), or Ny (years), e.g. 90d, 6mo, 1y',
    );
    return { exitCode: EXIT_CODE.validationError };
  }

  const minimumMtimeOverride = new Date(Date.now() - durationMs);

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
        cmd: 'backfill',
      },
    }));

  const http =
    deps.httpClient ??
    new HttpClient({
      apiKey: deps.config.account.apiKey,
      hostId: deps.config.account.hostId,
      endpoints: {
        ingest: deps.config.backend.ingestUrl,
        verifyKey: deps.config.backend.verifyKeyUrl,
        watermarks: deps.config.backend.watermarksUrl,
        registerHostId: deps.config.backend.registerHostIdUrl,
      },
      gatewayVersion: deps.gatewayVersion,
    });

  let cycleResult: PollCycleResult;
  try {
    if (countCursors(buffer) === 0) {
      try {
        await syncServerWatermarks({ buffer, http, logger });
      } catch (err) {
        logger.warn(
          { event: 'watermark_sync.failed', error: (err as Error).message ?? String(err) },
          'watermark sync failed; backfill will proceed without it',
        );
      }
    }

    const pacer = createPacer({
      maxBatchesPerSec: deps.config.capture.uploadMaxBatchesPerSec,
      maxBytesPerMinute: deps.config.capture.uploadMaxBytesPerMinute,
      backoffMultiplier: deps.config.capture.uploadBackoffOn429Multiplier,
    });

    const sources =
      deps.sources ??
      buildDefaultSources({
        initialScanWindowDays: deps.config.capture.initialScanWindowDays,
      });

    const cycleCtx: PollCycleContext = {
      buffer,
      http,
      hostId: deps.config.account.hostId,
      gatewayVersion: deps.gatewayVersion,
      sources,
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
      minimumMtimeOverride,
      logger,
    };

    deps.output.info(
      `running backfill cycle (--since ${options.since}, cap=${minimumMtimeOverride.toISOString()})`,
    );
    cycleResult = await runPollCycle(cycleCtx);
  } finally {
    buffer.close();
  }

  const totalBatches = sumCapturedBatches(cycleResult);
  const daemonRunning = deps.isDaemonRunning !== undefined ? await deps.isDaemonRunning() : false;
  if (daemonRunning) {
    deps.output.success(
      `captured ${totalBatches.toString()} batch(es); daemon will drain them respecting upload pacing`,
    );
  } else {
    deps.output.success(
      `captured ${totalBatches.toString()} batch(es); run \`proxai-gateway start\` to ship them`,
    );
  }
  return { exitCode: EXIT_CODE.ok };
}

function sumCapturedBatches(result: PollCycleResult): number {
  let total = 0;
  for (const r of Object.values(result.sourceResults)) {
    total += r.capturedBatches;
  }
  return total;
}
