export type UnifiedStatusLevel = 'ok' | 'warning' | 'error' | 'inactive';

export interface UnifiedStatusSummary {
  readonly level: UnifiedStatusLevel;
  readonly headline: string;
  readonly hint: string | null;
}

export interface UnifiedSummaryInputs {
  readonly configured: boolean;
  readonly daemonRunning: boolean;
  readonly daemonInferredAlive: boolean;
  readonly daemonLastCycleAt: string | null;
  readonly authFailed: boolean;
  readonly paused: boolean;
  readonly pausedReason: string;
  readonly bufferFull: boolean;
  readonly bufferFullPendingBytes: number | null;
  readonly bufferFullThreshold: number | null;
  readonly sessionStopped: boolean;
}
