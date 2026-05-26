import type { SourceApp } from 'services/contract';

export type QuarantineLifecycleState = 'quarantined' | 'pruned';

export interface QuarantinedRecord {
  readonly sourceApp: SourceApp;
  readonly sourcePathHash: string;
  readonly watermarkTable: string | null;
  readonly watermarkPosition: number;
  readonly redactedSizeBytes: number;
  readonly reason: string;
  readonly quarantinedAtUtc: string;
  readonly gatewayVersion: string;
}

export interface QuarantineLifecycleInput {
  readonly record: QuarantinedRecord;
}

export interface QuarantineLifecycleContext {
  readonly record: QuarantinedRecord;
  prunedAtUtc: string | null;
}

export interface QuarantinePruneEvent {
  readonly type: 'PRUNE';
  readonly prunedAtUtc: string;
}

export type QuarantineLifecycleEvent = QuarantinePruneEvent;
