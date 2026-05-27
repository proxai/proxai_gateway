export type CaptureLoopPhase =
  | 'waiting'
  | 'evaluating_gate'
  | 'running_cycle'
  | 'committing'
  | 'checking_pressure'
  | 'persisting_metrics'
  | 'skipped';

export type CaptureGateBlockReason = 'auth' | 'buffer_full';

export interface CaptureLoopInput {
  readonly intervalMs: number;
}

export interface CaptureLoopContext {
  readonly intervalMs: number;
  cyclesCompleted: number;
  cyclesSkipped: number;
  lastCycleAtUtc: string | null;
  lastCycleDurationMs: number | null;
  lastSkipReason: CaptureGateBlockReason | null;
  lastBatchesEmitted: number;
  lastQuarantineEmitted: number;
  pendingBytes: number | null;
  bufferFull: boolean;
}

export type CaptureLoopEvent =
  | { type: 'TICK'; startedAtUtc: string }
  | { type: 'GATE_BLOCKED'; reason: CaptureGateBlockReason }
  | { type: 'GATE_CLEAR' }
  | {
      type: 'POLL_COMPLETE';
      batchesEmitted: number;
      quarantineEmitted: number;
    }
  | { type: 'COMMITTED' }
  | { type: 'PRESSURE_EVALUATED'; pendingBytes: number; shouldPause: boolean }
  | { type: 'METRICS_PERSISTED'; finishedAtUtc: string; durationMs: number };
