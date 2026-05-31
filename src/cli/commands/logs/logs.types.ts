import type { Database } from 'bun:sqlite';

import type { OutputSink } from 'cli/cli.types.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';

export interface LogsCommandOptions {
  readonly static?: boolean;
  readonly json?: boolean;
  readonly failed?: boolean;
  readonly pending?: boolean;
  readonly verbose?: boolean;
  readonly id?: string;
  readonly source?: string;
  readonly since?: string;
  readonly lines?: number;
  readonly stdin?: ReadableInputStream;
  readonly intervalMs?: number;
}

export interface LogsCommandDeps {
  readonly output: OutputSink;
  readonly buffer: Database | null;
}

export interface UploadedRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly deliveredAt: string;
  readonly idempotentOnServer: boolean;
  readonly userPrompt: string | null;
  readonly userPromptAddedAt: string | null;
  readonly sourcePath: string | null;
  readonly sourcePathHash: string;
  readonly watermarkKind: string;
  readonly watermarkStart: number;
  readonly watermarkEnd: number;
  readonly watermarkTable: string | null;
  readonly agentSchemaVersion: string | null;
  readonly gatewayVersion: string | null;
  readonly capturedAtUtc: string | null;
  readonly shippedBytes: number | null;
  readonly attempts: number | null;
}

export interface FailedRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly capturedAtUtc: string;
  readonly sourcePath: string;
  readonly sourcePathHash: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly userPrompt: string | null;
  readonly assistantResponse: string | null;
  readonly watermarkKind: string;
  readonly watermarkStart: number;
  readonly watermarkEnd: number;
  readonly watermarkTable: string | null;
  readonly agentSchemaVersion: string | null;
  readonly gatewayVersion: string | null;
  readonly sourceInode: number | null;
  readonly sizeBytes: number;
}

export interface PendingRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly capturedAtUtc: string;
  readonly sourcePath: string;
  readonly sourcePathHash: string | null;
  readonly attempts: number;
  readonly userPrompt: string | null;
  readonly assistantResponse: string | null;
  readonly watermarkKind: string;
  readonly watermarkStart: number;
  readonly watermarkEnd: number;
  readonly watermarkTable: string | null;
  readonly agentSchemaVersion: string | null;
  readonly gatewayVersion: string | null;
  readonly sourceInode: number | null;
  readonly sizeBytes: number;
}

export interface QuarantinedRecord {
  readonly id: number;
  readonly sourceApp: string;
  readonly sourcePath: string;
  readonly sourcePathHash: string | null;
  readonly redactedSizeBytes: number;
  readonly reason: string;
  readonly quarantinedAtUtc: string;
}

export type CaptureLookup =
  | { readonly kind: 'uploaded'; readonly record: UploadedRecord }
  | { readonly kind: 'failed'; readonly record: FailedRecord }
  | { readonly kind: 'pending'; readonly record: PendingRecord };

export interface LogsFrame {
  readonly uploaded: UploadedRecord[];
  readonly failed: FailedRecord[];
  readonly quarantined: QuarantinedRecord[];
  readonly pending: PendingRecord[];
  readonly detail: CaptureLookup | null;
  readonly idQuery: string | null;
}
