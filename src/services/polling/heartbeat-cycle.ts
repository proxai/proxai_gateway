import { createActor } from 'xstate';
import { nowIsoUtc } from 'core/utils';
import { getMetadata, setMetadata } from 'services/buffer';
import { METADATA_KEYS } from 'services/buffer';
import type {
  HeartbeatCycleContext,
  HeartbeatCycleResult,
} from 'services/polling/polling.types.ts';
import { checkStaleBinary, type StaleBinaryStatus } from 'services/polling/stale-binary.ts';
import {
  clearUpdateAvailableSentinel,
  writeUpdateAvailableSentinel,
} from 'services/polling/update-available-sentinel.ts';
import { checkLatestVersion } from 'services/polling/version-check.ts';
import type { BinaryFreshnessStatus } from 'services/state-machines/binary-freshness';
import { heartbeatLoopMachine } from 'services/state-machines/heartbeat-loop';
import { runAutoUpgrade } from 'services/upgrade';

const DEFAULT_VERSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function toFreshnessStatus(status: StaleBinaryStatus): BinaryFreshnessStatus {
  return status;
}

export async function runHeartbeatCycle(ctx: HeartbeatCycleContext): Promise<HeartbeatCycleResult> {
  const startedAt = nowIsoUtc();
  const startMs = Date.now();
  const log = ctx.logger;

  const cycleMachine = createActor(heartbeatLoopMachine, {
    input: {
      intervalMs: 0,
      versionCheckIntervalMs: ctx.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS,
    },
  });
  cycleMachine.start();
  cycleMachine.send({ type: 'TICK', startedAtUtc: startedAt });

  log?.info({ event: 'heartbeat.cycle.start', started_at: startedAt }, 'heartbeat cycle started');

  cycleMachine.send({ type: 'GATE_CLEAR' });

  const staleDeps: Parameters<typeof checkStaleBinary>[0] = {
    installedAt: ctx.installedAt,
    warnAfterDays: ctx.staleBinary.warnAfterDays,
    pauseAfterDays: ctx.staleBinary.pauseAfterDays,
  };
  if (log !== undefined) staleDeps.logger = log;
  const freshness = await checkStaleBinary(staleDeps);
  cycleMachine.send({ type: 'FRESHNESS_CHECKED', status: toFreshnessStatus(freshness.status) });

  let ranAutoUpgrade = false;
  if (shouldRunAutoUpgrade(ctx)) {
    try {
      const interval = ctx.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS;
      const lastCheck = getMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt);
      const lastMs = lastCheck === null ? 0 : Date.parse(lastCheck);
      const throttled =
        lastCheck !== null && Number.isFinite(lastMs) && Date.now() - lastMs < interval;
      if (throttled) {
        cycleMachine.send({ type: 'THROTTLE_BLOCKS' });
      } else {
        cycleMachine.send({ type: 'THROTTLE_ALLOWS' });
        ranAutoUpgrade = await maybeRunAutoUpgrade(ctx);
        cycleMachine.send({
          type: 'VERSION_CHECK_COMPLETE',
          ranAutoUpgrade,
          checkedAtUtc: nowIsoUtc(),
        });
      }
    } catch (err) {
      log?.warn(
        { event: 'version_check.failed', error: (err as Error).message ?? String(err) },
        'version check failed; continuing heartbeat',
      );
      cycleMachine.send({ type: 'THROTTLE_BLOCKS' });
    }
  } else {
    cycleMachine.send({ type: 'THROTTLE_BLOCKS' });
  }

  const completedAt = nowIsoUtc();
  const durationMs = Date.now() - startMs;
  log?.info(
    { event: 'heartbeat.cycle.complete', duration_ms: durationMs, completed_at: completedAt },
    'heartbeat cycle complete',
  );

  cycleMachine.send({ type: 'METRICS_PERSISTED', finishedAtUtc: completedAt, durationMs });
  cycleMachine.stop();

  return { startedAt, completedAt, durationMs, ranAutoUpgrade };
}

export function shouldRunAutoUpgrade(ctx: HeartbeatCycleContext): boolean {
  if (ctx.installSource === 'brew') {
    return ctx.updateAvailableSentinelPath !== undefined;
  }
  return ctx.binaryPath !== undefined && ctx.currentVersion !== undefined;
}

async function maybeRunAutoUpgrade(ctx: HeartbeatCycleContext): Promise<boolean> {
  if (ctx.installSource === 'brew') {
    await runBrewSentinelCheck(ctx);
    setMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt, nowIsoUtc());
    return true;
  }

  if (ctx.binaryPath === undefined || ctx.currentVersion === undefined) return false;
  const autoDeps: Parameters<typeof runAutoUpgrade>[0] = {
    binaryPath: ctx.binaryPath,
    currentVersion: ctx.currentVersion,
    onLatestVersionKnown: (v) => {
      setMetadata(ctx.buffer, METADATA_KEYS.latestKnownVersion, v);
    },
  };
  if (ctx.devMode !== undefined) autoDeps.devMode = ctx.devMode;
  if (ctx.installSource !== undefined) autoDeps.installSource = ctx.installSource;
  if (ctx.versionCheckFetch !== undefined) autoDeps.fetch = ctx.versionCheckFetch;
  if (ctx.logger !== undefined) autoDeps.logger = ctx.logger;
  if (ctx.exitProcess !== undefined) autoDeps.exitProcess = ctx.exitProcess;
  await runAutoUpgrade(autoDeps);
  setMetadata(ctx.buffer, METADATA_KEYS.lastVersionCheckAt, nowIsoUtc());
  return true;
}

async function runBrewSentinelCheck(ctx: HeartbeatCycleContext): Promise<void> {
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
  setMetadata(ctx.buffer, METADATA_KEYS.latestKnownVersion, result.latestVersion);
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
