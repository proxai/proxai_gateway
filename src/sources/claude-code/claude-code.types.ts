import type { Database } from 'bun:sqlite';

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
