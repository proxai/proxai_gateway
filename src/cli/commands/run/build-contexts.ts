import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import { resolveMaxDecompressed } from 'services/config';
import type { HttpClient } from 'services/http';
import { runDaemonLoops } from 'services/polling';
import type {
  CaptureCycleContext,
  DaemonLoopContexts,
  DrainCycleContext,
  HeartbeatCycleContext,
  RegisteredSource,
} from 'services/polling';
import type { Pacer } from 'services/uploader';

import type { RunCommandDeps } from 'cli/commands/run/run.types.ts';

export function buildCaptureContext(input: {
  buffer: Database;
  deps: RunCommandDeps;
  sources: readonly RegisteredSource[];
  logger: Logger;
}): CaptureCycleContext {
  const { buffer, deps, sources, logger } = input;
  return {
    buffer,
    gatewayVersion: deps.gatewayVersion,
    sources,
    authFailedSentinelPath: deps.authFailedSentinelPath,
    bufferFullSentinelPath: deps.bufferFullSentinelPath,
    bufferPolicy: {
      receiptRetentionDays: deps.config.capture.receiptRetentionDays,
      failedRetentionDays: deps.config.capture.failedRetentionDays,
      softPauseBytes: deps.config.capture.bufferSoftPauseBytes,
      softResumeBytes: deps.config.capture.bufferSoftResumeBytes,
    },
    capturePolicy: {
      maxDecompressedBytes: resolveMaxDecompressed(deps.config.capture),
    },
    logger,
  };
}

export function buildDrainContext(input: {
  buffer: Database;
  deps: RunCommandDeps;
  http: HttpClient;
  pacer: Pacer;
  logger: Logger;
}): DrainCycleContext {
  const { buffer, deps, http, pacer, logger } = input;
  return {
    buffer,
    http,
    hostId: deps.config.account.hostId,
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
}

export function buildHeartbeatContext(input: {
  buffer: Database;
  deps: RunCommandDeps;
  logger: Logger;
}): HeartbeatCycleContext {
  const { buffer, deps, logger } = input;
  const heartbeatCtx: HeartbeatCycleContext = {
    buffer,
    gatewayVersion: deps.gatewayVersion,
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
  return heartbeatCtx;
}

export function buildLoopOptions(deps: RunCommandDeps): Parameters<typeof runDaemonLoops>[1] {
  const opts: Parameters<typeof runDaemonLoops>[1] = { abortSignal: deps.abortSignal };
  if (deps.captureIntervalMs !== undefined) opts.captureIntervalMs = deps.captureIntervalMs;
  if (deps.drainIntervalMs !== undefined) opts.drainIntervalMs = deps.drainIntervalMs;
  if (deps.heartbeatIntervalMs !== undefined) opts.heartbeatIntervalMs = deps.heartbeatIntervalMs;
  if (deps.onCaptureComplete !== undefined) opts.onCaptureComplete = deps.onCaptureComplete;
  if (deps.onDrainComplete !== undefined) opts.onDrainComplete = deps.onDrainComplete;
  if (deps.onHeartbeatComplete !== undefined) opts.onHeartbeatComplete = deps.onHeartbeatComplete;
  return opts;
}

export function buildDaemonContexts(input: {
  capture: CaptureCycleContext;
  drain: DrainCycleContext;
  heartbeat: HeartbeatCycleContext;
}): DaemonLoopContexts {
  return { capture: input.capture, drain: input.drain, heartbeat: input.heartbeat };
}
