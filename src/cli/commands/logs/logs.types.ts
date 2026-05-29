import type { Database } from 'bun:sqlite';

import type { OutputSink } from 'cli/cli.types.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';

export interface LogsCommandOptions {
  readonly static?: boolean;
  readonly json?: boolean;
  readonly error?: boolean;
  readonly source?: string;
  readonly since?: string;
  readonly pending?: boolean;
  readonly lines?: number;
  readonly stdin?: ReadableInputStream;
  readonly intervalMs?: number;
  readonly compact?: boolean;
}

export interface LogsCommandDeps {
  readonly output: OutputSink;
  readonly buffer: Database | null;
  readonly isDevMode: boolean;
}

export interface UploadedRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly deliveredAt: string;
  readonly watermarkKind: string;
  readonly sourcePathHash: string;
  readonly idempotentOnServer: boolean;
}

export interface FailedRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly capturedAtUtc: string;
  readonly sourcePath: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface QuarantinedRecord {
  readonly id: number;
  readonly sourceApp: string;
  readonly sourcePath: string;
  readonly redactedSizeBytes: number;
  readonly reason: string;
  readonly quarantinedAtUtc: string;
}

export interface PendingRecord {
  readonly captureId: string;
  readonly sourceApp: string;
  readonly capturedAtUtc: string;
  readonly sourcePath: string;
  readonly attempts: number;
}

export interface LogsFrame {
  readonly uploaded: UploadedRecord[];
  readonly failed: FailedRecord[];
  readonly quarantined: QuarantinedRecord[];
  readonly pending: PendingRecord[];
}
