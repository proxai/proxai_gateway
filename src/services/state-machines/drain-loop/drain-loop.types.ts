export type DrainLoopPhase =
  | 'waiting'
  | 'evaluating_gate'
  | 'draining'
  | 'pruning'
  | 'checking_resume'
  | 'persisting_metrics'
  | 'skipped';

export type DrainGateBlockReason = 'auth';

export interface DrainLoopInput {
  readonly intervalMs: number;
}

export interface DrainLoopContext {
  readonly intervalMs: number;
  cyclesCompleted: number;
  cyclesSkipped: number;
  lastCycleAtUtc: string | null;
  lastCycleDurationMs: number | null;
  lastSkipReason: DrainGateBlockReason | null;
  lastAccepted: number;
  lastRetriable: number;
  lastFatal: number;
  lastRecovered: number;
  lastAcceptedBytes: number;
  consecutiveRetriableBreak: boolean;
  bufferFullCleared: boolean;
}

export type DrainLoopEvent =
  | { type: 'TICK'; startedAtUtc: string }
  | { type: 'GATE_BLOCKED'; reason: DrainGateBlockReason }
  | { type: 'GATE_CLEAR' }
  | {
      type: 'DRAIN_COMPLETE';
      accepted: number;
      retriable: number;
      fatal: number;
      recovered: number;
      acceptedBytes: number;
      consecutiveRetriableBreak: boolean;
    }
  | { type: 'PRUNE_COMPLETE' }
  | { type: 'RESUME_EVALUATED'; clearedBufferFull: boolean }
  | { type: 'METRICS_PERSISTED'; finishedAtUtc: string; durationMs: number };
