import type {
  BodyCompression,
  BodyFormat,
  SourceApp,
  SourceKind,
  SourcePlatform,
} from 'services/contract';

export const GEMINI_SOURCE_APP: SourceApp = 'gemini';

export const GEMINI_SOURCE_KIND: SourceKind = 'jsonl_append';

export const GEMINI_BODY_FORMAT: BodyFormat = 'jsonl';

export const GEMINI_BODY_COMPRESSION: BodyCompression = 'zstd';

export const GEMINI_DEFAULT_AGENT_SCHEMA_VERSION = 'antigravity/2.0.0';

// Token capture (content-free `gen_metadata` from conversations/<uuid>.db). Shipped
// as a SECOND capture stamped with the transcript's source_path so it lands on the
// same chat; nest routes the chat to gemini/v3 by max-version resolution. The jsonl
// content capture stays at 2.0.0 and is otherwise UNCHANGED.
export const GEMINI_TOKEN_SOURCE_KIND: SourceKind = 'sqlite_table_snapshot';
export const GEMINI_TOKEN_BODY_FORMAT: BodyFormat = 'sqlite_rows_json';
export const GEMINI_V3_AGENT_SCHEMA_VERSION = 'antigravity/3.0.0';
export const GEMINI_GEN_METADATA_TABLE = 'gen_metadata';

export const GEMINI_ANTIGRAVITY_BASE_SUBPATH = '.gemini/antigravity';
export const GEMINI_TRANSCRIPT_GLOB = 'brain/*/.system_generated/logs/transcript.jsonl';
export const GEMINI_CONVERSATIONS_DB_GLOB = 'conversations/*.db';
export const GEMINI_AGYHUB_FILE = 'agyhub_summaries_proto.pb';

export const ANTIGRAVITY_CLI_PLATFORM: SourcePlatform = 'antigravity-cli';
export const ANTIGRAVITY_IDE_PLATFORM: SourcePlatform = 'antigravity-ide';
