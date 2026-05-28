import type { Database } from 'bun:sqlite';
import type { Logger } from 'core/log';

export interface DiscoveredClaudeDesktopFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface ClaudeDesktopCollectorContext {
  buffer: Database;
  maxDecompressedBytes: number;
  logger?: Logger;
}

export interface ClaudeDesktopCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: { sourcePath: string; reason: string }[];
}
