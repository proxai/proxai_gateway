import type {
  BodyCompression,
  BodyFormat,
  SourceApp,
  SourceKind,
  WatermarkKind,
} from 'services/contract';

export type BatchStatus = 'pending' | 'failed';

export interface NewBatch {
  captureId: string;
  sourceApp: SourceApp;
  sourceKind: SourceKind;
  sourcePath: string;
  sourcePathHash: string;
  sourceInode: number | null;
  watermarkKind: WatermarkKind;
  watermarkStart: number;
  watermarkEnd: number;
  watermarkTable: string | null;
  agentSchemaVersion: string;
  gatewayVersion: string;
  capturedAtUtc: string;
  bodyFormat: BodyFormat;
  bodyCompression: BodyCompression;
  body: Uint8Array;
}

export interface StoredBatch extends NewBatch {
  status: BatchStatus;
  attempts: number;
  createdAt: string;
  lastError: string | null;
}

export interface CursorKey {
  sourceApp: SourceApp;
  sourcePathHash: string;
  sourceInode: number | null;
  watermarkTable: string | null;
}

export interface CursorState {
  watermarkEnd: number;
  lastPolledAt: string;
  consecutiveErrors: number;
}

export interface SetCursorInput extends CursorKey {
  sourcePath: string;
  watermarkEnd: number;
  consecutiveErrors?: number;
}

export interface NewReceipt {
  captureId: string;
  sourceApp: SourceApp;
  sourcePathHash: string;
  watermarkKind: WatermarkKind;
  watermarkStart: number;
  watermarkEnd: number;
  watermarkTable: string | null;
  deliveredAt: string;
  idempotentOnServer: boolean;
}

export interface StoredReceipt extends NewReceipt {}

export interface BufferCounts {
  pending: number;
  failed: number;
  delivered: number;
}
