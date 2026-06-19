import type { Database } from 'bun:sqlite';

import type { MinimalLogger } from 'core/log';
import type { GeminiTable, SourcePlatform } from 'services/contract';

export type GeminiRole = 'user' | 'assistant' | 'tool' | 'system';

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
}

export interface GeminiCollectorError {
  sourcePath: string;
  reason: string;
  table?: GeminiTable;
}

export interface GeminiCollectorResult {
  capturedBatches: number;
  capturedBytes: number;
  errors: GeminiCollectorError[];
}

export interface NormalizedStepIds {
  trajectoryId: string | null;
  cascadeId: string | null;
  idx: number | null;
  turnGroup: string | null;
  requestId: string | null;
  sessionId: string | null;
}

export interface NormalizedStep {
  stepType: number;
  role: GeminiRole | null;
  text: string | null;
  toolName: string | null;
  toolArgsJson: string | null;
  isoTimestamp: string | null;
  ids: NormalizedStepIds;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

export interface GeminiStepRow {
  idx: number;
  step_type: number;
  status: number | null;
  role: GeminiRole | null;
  text: string | null;
  tool_name: string | null;
  tool_args_json: string | null;
  iso_timestamp: string | null;
  turn_id: string | null;
  conversation_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
}

export interface GeminiTrajectoryMetaRow {
  idx: number;
  trajectory_id: string | null;
  cascade_id: string | null;
  trajectory_type: number | null;
  source: number | null;
}

export interface GeminiTrajectoryMetadataBlobRow {
  idx: number;
  workspace_path: string | null;
  git_remote: string | null;
}

export type GeminiRowObject =
  | GeminiStepRow
  | GeminiTrajectoryMetaRow
  | GeminiTrajectoryMetadataBlobRow;
