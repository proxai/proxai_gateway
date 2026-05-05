import type {
  BodyCompression,
  BodyFormat,
  CodexTable,
  SourceApp,
  SourceKind,
} from 'services/contract';

export const CODEX_SOURCE_APP: SourceApp = 'codex';

export const CODEX_ROLLOUT_SOURCE_KIND: SourceKind = 'jsonl_append';
export const CODEX_ROLLOUT_BODY_FORMAT: BodyFormat = 'jsonl';

export const CODEX_STATE_SOURCE_KIND: SourceKind = 'sqlite_table_snapshot';
export const CODEX_STATE_BODY_FORMAT: BodyFormat = 'sqlite_rows_json';

export const CODEX_BODY_COMPRESSION: BodyCompression = 'zstd';

export const CODEX_HOME_SUBPATH = '.codex';
export const CODEX_ROLLOUT_GLOB = 'sessions/*/*/*/rollout-*.jsonl';
export const CODEX_STATE_GLOB = 'state_*.sqlite';

export const CODEX_THREADS_TABLE: CodexTable = 'threads';
export const CODEX_THREAD_DYNAMIC_TOOLS_TABLE: CodexTable = 'thread_dynamic_tools';
export const CODEX_THREAD_SPAWN_EDGES_TABLE: CodexTable = 'thread_spawn_edges';

export const CODEX_ALLOWED_STATE_TABLES: readonly CodexTable[] = [
  CODEX_THREADS_TABLE,
  CODEX_THREAD_DYNAMIC_TOOLS_TABLE,
  CODEX_THREAD_SPAWN_EDGES_TABLE,
];

export const CODEX_DEFAULT_AGENT_SCHEMA_VERSION = 'unknown';
