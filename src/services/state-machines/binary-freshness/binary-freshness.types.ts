export type BinaryFreshnessStatus = 'unchecked' | 'fresh' | 'warning' | 'stale_paused';

export interface BinaryFreshnessInput {
  readonly pauseSentinelPath: string;
}

export interface BinaryFreshnessContext {
  readonly pauseSentinelPath: string;
  lastEvaluatedAt: number | null;
  lastDaysSinceInstall: number | null;
}

export interface BinaryFreshnessCheckEvent {
  readonly type: 'CHECK';
  readonly installedAt: string;
  readonly warnAfterDays: number;
  readonly pauseAfterDays: number;
  readonly nowMs: number;
}

export type BinaryFreshnessEvent = BinaryFreshnessCheckEvent;

export interface BinaryFreshnessEvaluation {
  readonly status: Exclude<BinaryFreshnessStatus, 'unchecked'>;
  readonly daysSinceInstall: number | null;
  readonly evaluatedAtMs: number;
}
