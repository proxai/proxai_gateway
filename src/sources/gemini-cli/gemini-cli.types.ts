import type { Database } from 'bun:sqlite';

import type { Logger } from 'core/log';

export interface DiscoveredGeminiCliFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface GeminiCliCollectorContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: Logger;
  detectVersion?: () => Promise<string | null>;
}

export interface GeminiCliCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: GeminiCliCollectorError[];
}

export interface GeminiCliCollectorError {
  sourcePath: string;
  reason: string;
}
