import { dirname } from 'node:path';

import { ensureSecureBaseDirs } from 'core/io/fs/mode.ts';
import { createLogger, pruneLogDirectory } from 'core/log';
import { readBootId } from 'core/system';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { countCursors, openBufferDb } from 'services/buffer';
import { HttpClient } from 'services/http';
import {
  buildDefaultSources,
  isCurrentSessionStopped,
  runDaemonLoops,
  syncServerWatermarks,
} from 'services/polling';
import { createPacer } from 'services/uploader';

import {
  buildCaptureContext,
  buildDaemonContexts,
  buildDrainContext,
  buildHeartbeatContext,
  buildLoopOptions,
} from 'cli/commands/run/build-contexts.ts';
import type { RunCommandDeps } from 'cli/commands/run/run.types.ts';

export type { RunCommandDeps } from 'cli/commands/run/run.types.ts';

export async function runDaemon(deps: RunCommandDeps): Promise<CommandResult> {
  await ensureSecureBaseDirs([dirname(deps.config.capture.bufferPath), deps.config.logging.logDir]);

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
    { event: 'daemon.start', buffer_path: deps.config.capture.bufferPath },
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
    const sources = deps.sources ?? buildDefaultSources({});
    const captureCtx = buildCaptureContext({ buffer, deps, sources, logger });
    const drainCtx = buildDrainContext({ buffer, deps, http, pacer, logger });
    const heartbeatCtx = buildHeartbeatContext({ buffer, deps, logger });
    const contexts = buildDaemonContexts({
      capture: captureCtx,
      drain: drainCtx,
      heartbeat: heartbeatCtx,
    });
    try {
      await runDaemonLoops(contexts, buildLoopOptions(deps));
    } finally {
      pacer.stop();
    }
  } finally {
    logger.info({ event: 'daemon.stop' }, 'daemon shutting down');
    buffer.close();
  }

  deps.output.info('daemon loops exited');
  return { exitCode: EXIT_CODE.ok };
}
