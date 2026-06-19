import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';
import type { SourcePlatform } from 'services/contract';

export interface DiscoveredGeminiFile {
  sourcePath: string;
  sourcePathHash: string;
  inode: number;
  sizeBytes: number;
  lastModifiedMs: number;
  sourcePlatform: SourcePlatform;
  conversationId: string;
}

export interface GeminiCollectorContext {
  buffer: Database;
  gatewayVersion: string;
  maxDecompressedBytes: number;
  logger?: MinimalLogger;
  excludedProjects?: readonly string[];
  agyhubFolders?: ReadonlyMap<string, string[]>;
  /**
   * Truncated-read signal for the agyhub index this cycle. `false` = the `.pb` was read
   * mid-write; the collect gate fails CLOSED (pauses) when exclusions are active so a
   * conversation merely absent from a partial map cannot leak. Defaults to fail-open when omitted.
   */
  agyhubComplete?: boolean;
}

export interface GeminiCollectorError {
  sourcePath: string;
  reason: string;
}

export interface GeminiCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: GeminiCollectorError[];
}
