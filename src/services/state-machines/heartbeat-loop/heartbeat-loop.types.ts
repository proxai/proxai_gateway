import type { BinaryFreshnessStatus } from 'services/state-machines/binary-freshness/binary-freshness.types.ts';

export type HeartbeatLoopPhase =
  | 'waiting'
  | 'evaluating_gate'
  | 'checking_freshness'
  | 'throttle_check'
  | 'version_check_branch'
  | 'persisting_metrics'
  | 'skipped';

export interface HeartbeatLoopInput {
  readonly intervalMs: number;
  readonly versionCheckIntervalMs: number;
}

export interface HeartbeatLoopContext {
  readonly intervalMs: number;
  readonly versionCheckIntervalMs: number;
  cyclesCompleted: number;
  cyclesSkipped: number;
  lastCycleAtUtc: string | null;
  lastCycleDurationMs: number | null;
  lastFreshness: BinaryFreshnessStatus | null;
  lastVersionCheckAtUtc: string | null;
  ranAutoUpgrade: boolean;
}

export type HeartbeatLoopEvent =
  | { type: 'TICK'; startedAtUtc: string }
  | { type: 'GATE_BLOCKED' }
  | { type: 'GATE_CLEAR' }
  | { type: 'FRESHNESS_CHECKED'; status: BinaryFreshnessStatus }
  | { type: 'THROTTLE_ALLOWS' }
  | { type: 'THROTTLE_BLOCKS' }
  | { type: 'VERSION_CHECK_COMPLETE'; ranAutoUpgrade: boolean; checkedAtUtc: string }
  | { type: 'METRICS_PERSISTED'; finishedAtUtc: string; durationMs: number };
