import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';
import type { CodexTable } from 'services/contract';

export interface DiscoveredCodexRolloutFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface DiscoveredCodexStateFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface CodexCollectorContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: Logger;
}

export interface CodexCollectorError {
  sourcePath: string;
  reason: string;
  table?: CodexTable;
}

export interface CodexCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: CodexCollectorError[];
}

export interface CodexStateCollectorResult {
  agentSchemaVersion: string;
  result: CodexCollectorResult;
}
