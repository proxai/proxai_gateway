import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';

export interface DiscoveredCursorFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface CursorCollectorContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: MinimalLogger;
}

export interface CursorCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: CursorCollectorError[];
}

export interface CursorCollectorError {
  sourcePath: string;
  reason: string;
}

export interface CursorDiskKvRow {
  rowid: number;
  key: string;
  value: string;
}
