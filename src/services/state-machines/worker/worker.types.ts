import type { SourceApp } from 'services/contract';

export type WorkerPhase = 'spawned' | 'running' | 'posting_result' | 'terminated' | 'errored';

export interface WorkerInput {
  readonly sourceApp: SourceApp;
  readonly workerId: string;
}

export interface WorkerResultSummary {
  readonly batchCount: number;
  readonly quarantineCount: number;
  readonly cursorCount: number;
}

export interface WorkerContext {
  readonly sourceApp: SourceApp;
  readonly workerId: string;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  result: WorkerResultSummary | null;
  errorMessage: string | null;
}

export type WorkerEvent =
  | { type: 'BEGIN_RUN'; startedAtUtc: string }
  | { type: 'RESULT_POSTED'; result: WorkerResultSummary; finishedAtUtc: string }
  | { type: 'ERROR'; message: string; finishedAtUtc: string }
  | { type: 'TERMINATE' };
