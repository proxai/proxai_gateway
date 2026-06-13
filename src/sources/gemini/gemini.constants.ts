import type {
  BodyCompression,
  BodyFormat,
  GeminiTable,
  SourceApp,
  SourceKind,
  SourcePlatform,
} from 'services/contract';

export const GEMINI_SOURCE_APP: SourceApp = 'gemini';

export const GEMINI_SOURCE_KIND: SourceKind = 'sqlite_table_snapshot';

export const GEMINI_BODY_FORMAT: BodyFormat = 'sqlite_rows_json';

export const GEMINI_BODY_COMPRESSION: BodyCompression = 'zstd';

export const GEMINI_TRAJECTORY_META_TABLE: GeminiTable = 'trajectory_meta';
export const GEMINI_STEPS_TABLE: GeminiTable = 'steps';
export const GEMINI_TRAJECTORY_METADATA_BLOB_TABLE: GeminiTable = 'trajectory_metadata_blob';

export const GEMINI_ALLOWED_TABLES: readonly GeminiTable[] = [
  GEMINI_TRAJECTORY_META_TABLE,
  GEMINI_STEPS_TABLE,
  GEMINI_TRAJECTORY_METADATA_BLOB_TABLE,
];

export const GEMINI_CONVERSATIONS_GLOB = '*.db';

export const GEMINI_DEFAULT_AGENT_SCHEMA_VERSION = 'antigravity/1.0.0';

export const ANTIGRAVITY_CLI_PLATFORM: SourcePlatform = 'antigravity-cli';
export const ANTIGRAVITY_IDE_PLATFORM: SourcePlatform = 'antigravity-ide';

export const GEMINI_HOME_SUBPATH = '.gemini';
export const GEMINI_CLI_VARIANT_DIR = 'antigravity-cli';
export const GEMINI_IDE_VARIANT_DIR = 'antigravity-ide';
export const GEMINI_CONVERSATIONS_DIR = 'conversations';

export const GEMINI_USER_STEP_TYPE = 14;
