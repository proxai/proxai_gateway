import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';

export interface DiscoveredClaudeCodeFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface ClaudeCodeCollectorContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: MinimalLogger;
  desktopCliSessionIds?: ReadonlySet<string>;
}

export interface ClaudeCodeCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: ClaudeCodeCollectorError[];
}

export interface ClaudeCodeCollectorError {
  sourcePath: string;
  reason: string;
}
