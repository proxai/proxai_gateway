import type { SourceApp } from 'services/contract';

export type CursorLifecyclePhase = 'unseeded' | 'syncing' | 'healthy' | 'vacuumed' | 'regressed';

export interface CursorIdentity {
  readonly sourceApp: SourceApp;
  readonly sourcePathHash: string;
  readonly sourceInode: number | null;
  readonly watermarkTable: string | null;
}

export interface CursorLifecycleInput {
  readonly identity: CursorIdentity;
}

export interface CursorLifecycleContext {
  readonly identity: CursorIdentity;
  watermarkEnd: number;
  consecutiveErrors: number;
  lastSeenSizeBytes: number | null;
  lastSeenPageCount: number | null;
  lastPolledAt: string | null;
  generation: number;
  lastServerWatermarkEnd: number | null;
}

export type CursorLifecycleEvent =
  | { type: 'SYNCED'; watermarkEnd: number; polledAtUtc: string }
  | {
      type: 'POLL_SUCCESS';
      watermarkEnd: number;
      polledAtUtc: string;
      lastSeenSizeBytes: number | null;
      lastSeenPageCount: number | null;
    }
  | { type: 'POLL_ERROR'; polledAtUtc: string }
  | { type: 'VACUUM_DETECTED' }
  | { type: 'NEW_GENERATION_CREATED' }
  | { type: 'WATERMARK_REGRESSED'; serverWatermarkEnd: number }
  | { type: 'REGRESSION_APPLIED' };
