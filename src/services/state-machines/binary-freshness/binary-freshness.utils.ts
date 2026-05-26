import {
  MS_PER_DAY,
  STALE_BINARY_REASON_PREFIX,
} from 'services/state-machines/binary-freshness/binary-freshness.constants.ts';
import type {
  BinaryFreshnessCheckEvent,
  BinaryFreshnessEvaluation,
} from 'services/state-machines/binary-freshness/binary-freshness.types.ts';

export function evaluateBinaryFreshness(
  event: BinaryFreshnessCheckEvent,
): BinaryFreshnessEvaluation {
  const installedAtMs = Date.parse(event.installedAt);
  if (!Number.isFinite(installedAtMs)) {
    return { status: 'fresh', daysSinceInstall: null, evaluatedAtMs: event.nowMs };
  }
  const daysSinceInstall = Math.max(0, Math.floor((event.nowMs - installedAtMs) / MS_PER_DAY));
  if (event.pauseAfterDays > 0 && daysSinceInstall >= event.pauseAfterDays) {
    return { status: 'stale_paused', daysSinceInstall, evaluatedAtMs: event.nowMs };
  }
  if (event.warnAfterDays > 0 && daysSinceInstall >= event.warnAfterDays) {
    return { status: 'warning', daysSinceInstall, evaluatedAtMs: event.nowMs };
  }
  return { status: 'fresh', daysSinceInstall, evaluatedAtMs: event.nowMs };
}

export function buildStalePauseReason(daysSinceInstall: number, pauseAfterDays: number): string {
  return `${STALE_BINARY_REASON_PREFIX}: ${daysSinceInstall.toString()} days since install (>= ${pauseAfterDays.toString()})`;
}
