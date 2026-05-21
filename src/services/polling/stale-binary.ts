import type { Logger } from 'core/log';
import { pausePolling } from 'services/polling/pause-sentinel.ts';

export type StaleBinaryStatus = 'fresh' | 'warning' | 'paused';

const MS_PER_DAY = 86_400_000;

export interface CheckStaleBinaryDeps {
  installedAt: string;
  warnAfterDays: number;
  pauseAfterDays: number;
  pauseSentinelPath: string;
  now?: () => number;
  logger?: Logger;
}

export async function checkStaleBinary(
  deps: CheckStaleBinaryDeps,
): Promise<{ status: StaleBinaryStatus }> {
  const log = deps.logger;
  const installedAtMs = Date.parse(deps.installedAt);
  if (!Number.isFinite(installedAtMs)) {
    log?.warn(
      { event: 'stale_binary.installed_at_invalid', installed_at: deps.installedAt },
      'invalid installedAt; skipping stale-binary check',
    );
    return { status: 'fresh' };
  }
  const nowMs = (deps.now ?? Date.now)();
  const daysSinceInstall = Math.max(0, Math.floor((nowMs - installedAtMs) / MS_PER_DAY));
  if (deps.pauseAfterDays > 0 && daysSinceInstall >= deps.pauseAfterDays) {
    await pausePolling(
      deps.pauseSentinelPath,
      `stale_binary: ${daysSinceInstall.toString()} days since install (>= ${deps.pauseAfterDays.toString()})`,
    );
    log?.warn(
      {
        event: 'stale_binary.paused',
        days_since_install: daysSinceInstall,
        pause_after_days: deps.pauseAfterDays,
      },
      'stale binary: paused polling until upgrade',
    );
    return { status: 'paused' };
  }
  if (deps.warnAfterDays > 0 && daysSinceInstall >= deps.warnAfterDays) {
    log?.warn(
      {
        event: 'stale_binary.warning',
        days_since_install: daysSinceInstall,
        warn_after_days: deps.warnAfterDays,
      },
      'stale binary: warning threshold reached',
    );
    return { status: 'warning' };
  }
  return { status: 'fresh' };
}
