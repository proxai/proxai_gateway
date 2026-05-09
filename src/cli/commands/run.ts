import { ensureDir } from 'core/io/fs';
import { dirname } from 'node:path';

import { createLogger, pruneLogDirectory } from 'core/log';
import type { Logger } from 'core/log';
import { readBootId } from 'core/system';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { countCursors, openBufferDb } from 'services/buffer';
import { resolveMaxDecompressed } from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';
import { HttpClient } from 'services/http';
import {
  buildDefaultSources,
  isCurrentSessionStopped,
  runDaemonLoops,
  syncServerWatermarks,
} from 'services/polling';
import type {
  CaptureCycleContext,
  CaptureCycleResult,
  DaemonLoopContexts,
  DrainCycleContext,
  DrainCycleResult,
  HeartbeatCycleContext,
  HeartbeatCycleResult,
  RegisteredSource,
} from 'services/polling';
import { createPacer } from 'services/uploader';

export interface RunCommandDeps {
  output: OutputSink;
  config: GatewayConfig;
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  abortSignal: AbortSignal;
  gatewayVersion: string;
  currentVersion?: string;
  binaryPath?: string;
  installSource?: InstallSource;
  devMode?: boolean;
  exitProcess?: () => void;
  sources?: readonly RegisteredSource[];
  onCaptureComplete?: (result: CaptureCycleResult) => void;
  onDrainComplete?: (result: DrainCycleResult) => void;
  onHeartbeatComplete?: (result: HeartbeatCycleResult) => void;
  captureIntervalMs?: number;
  drainIntervalMs?: number;
  heartbeatIntervalMs?: number;
  logger?: Logger;
  httpClient?: HttpClient;
  readBootId?: () => Promise<string>;
}

export async function runDaemon(deps: RunCommandDeps): Promise<CommandResult> {
  await ensureDir(dirname(deps.config.capture.bufferPath));

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
  } catch {}

  try {
    const readBootIdFn = deps.readBootId ?? readBootId;
    const currentBootId = await readBootIdFn();
    const sessionStopped = await isCurrentSessionStopped(
      deps.sessionStoppedSentinelPath,
      currentBootId,
    );
    if (sessionStopped) {
      logger.info(
        { event: 'daemon.session_stopped' },
        'session-stopped sentinel present; exiting cleanly',
      );
      return { exitCode: EXIT_CODE.ok };
    }
  } catch (err) {
    logger.warn(
      {
        event: 'daemon.session_stopped_check_failed',
        error: (err as Error).message ?? String(err),
      },
      'session-stopped check failed; proceeding with daemon start',
    );
  }

  const buffer = openBufferDb(deps.config.capture.bufferPath);

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

  logger.info(
    {
      event: 'daemon.start',
      buffer_path: deps.config.capture.bufferPath,
    },
    'daemon starting',
  );

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
    deps.output.info('starting capture / drain / heartbeat loops');

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

    const captureCtx: CaptureCycleContext = {
      buffer,
      gatewayVersion: deps.gatewayVersion,
      sources,
      pauseSentinelPath: deps.pauseSentinelPath,
      authFailedSentinelPath: deps.authFailedSentinelPath,
      bufferFullSentinelPath: deps.bufferFullSentinelPath,
      bufferPolicy: {
        receiptRetentionDays: deps.config.capture.receiptRetentionDays,
        failedRetentionDays: deps.config.capture.failedRetentionDays,
        softPauseBytes: deps.config.capture.bufferSoftPauseBytes,
        softResumeBytes: deps.config.capture.bufferSoftResumeBytes,
      },
      capturePolicy: {
        initialScanWindowDays: deps.config.capture.initialScanWindowDays,
        maxDecompressedBytes: resolveMaxDecompressed(deps.config.capture),
      },
      logger,
    };

    const drainCtx: DrainCycleContext = {
      buffer,
      http,
      hostId: deps.config.account.hostId,
      pauseSentinelPath: deps.pauseSentinelPath,
      authFailedSentinelPath: deps.authFailedSentinelPath,
      bufferFullSentinelPath: deps.bufferFullSentinelPath,
      bufferPolicy: {
        receiptRetentionDays: deps.config.capture.receiptRetentionDays,
        failedRetentionDays: deps.config.capture.failedRetentionDays,
        softPauseBytes: deps.config.capture.bufferSoftPauseBytes,
        softResumeBytes: deps.config.capture.bufferSoftResumeBytes,
      },
      pacer,
      logger,
    };

    const heartbeatCtx: HeartbeatCycleContext = {
      buffer,
      gatewayVersion: deps.gatewayVersion,
      pauseSentinelPath: deps.pauseSentinelPath,
      installedAt: deps.config.account.installedAt,
      staleBinary: {
        warnAfterDays: deps.config.staleBinary.warnAfterDays,
        pauseAfterDays: deps.config.staleBinary.pauseAfterDays,
      },
      installSource: deps.installSource ?? deps.config.account.installSource,
      logger,
    };
    if (deps.updateAvailableSentinelPath !== undefined) {
      heartbeatCtx.updateAvailableSentinelPath = deps.updateAvailableSentinelPath;
    }
    if (deps.currentVersion !== undefined) heartbeatCtx.currentVersion = deps.currentVersion;
    if (deps.binaryPath !== undefined) heartbeatCtx.binaryPath = deps.binaryPath;
    if (deps.devMode !== undefined) heartbeatCtx.devMode = deps.devMode;
    if (deps.exitProcess !== undefined) heartbeatCtx.exitProcess = deps.exitProcess;

    const contexts: DaemonLoopContexts = {
      capture: captureCtx,
      drain: drainCtx,
      heartbeat: heartbeatCtx,
    };
    const loopOptions: Parameters<typeof runDaemonLoops>[1] = {
      abortSignal: deps.abortSignal,
    };
    if (deps.captureIntervalMs !== undefined)
      loopOptions.captureIntervalMs = deps.captureIntervalMs;
    if (deps.drainIntervalMs !== undefined) loopOptions.drainIntervalMs = deps.drainIntervalMs;
    if (deps.heartbeatIntervalMs !== undefined) {
      loopOptions.heartbeatIntervalMs = deps.heartbeatIntervalMs;
    }
    if (deps.onCaptureComplete !== undefined)
      loopOptions.onCaptureComplete = deps.onCaptureComplete;
    if (deps.onDrainComplete !== undefined) loopOptions.onDrainComplete = deps.onDrainComplete;
    if (deps.onHeartbeatComplete !== undefined) {
      loopOptions.onHeartbeatComplete = deps.onHeartbeatComplete;
    }

    await runDaemonLoops(contexts, loopOptions);
  } finally {
    logger.info({ event: 'daemon.stop' }, 'daemon shutting down');
    buffer.close();
  }

  deps.output.info('daemon loops exited');
  return { exitCode: EXIT_CODE.ok };
}
