import type { SourceApp } from 'services/contract';

export type SourcePollPhase =
  | 'idle'
  | 'discovering'
  | 'processing'
  | 'emitting_results'
  | 'done'
  | 'errored';

export interface SourcePollInput {
  readonly sourceApp: SourceApp;
}

export interface SourcePollCounters {
  filesDiscovered: number;
  filesProcessed: number;
  filesFailed: number;
  batchesEmitted: number;
  quarantineEmitted: number;
  cursorUpdates: number;
}

export interface SourcePollContext extends SourcePollCounters {
  readonly sourceApp: SourceApp;
  startedAtUtc: string | null;
  finishedAtUtc: string | null;
  lastError: string | null;
}

export type SourcePollEvent =
  | { type: 'BEGIN_POLL'; startedAtUtc: string }
  | { type: 'FILES_FOUND'; count: number }
  | { type: 'NO_FILES' }
  | { type: 'DISCOVERY_ERROR'; message: string }
  | {
      type: 'FILE_PROCESSED';
      batchesEmitted: number;
      quarantineEmitted: number;
      cursorUpdates: number;
    }
  | { type: 'FILE_FAILED'; message: string }
  | { type: 'ALL_FILES_PROCESSED' }
  | { type: 'EMIT_COMPLETE'; finishedAtUtc: string };
