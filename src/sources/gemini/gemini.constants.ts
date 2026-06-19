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

export const GEMINI_ANTIGRAVITY_BASE_SUBPATH = '.gemini/antigravity';
export const GEMINI_TRANSCRIPT_GLOB = 'brain/*/.system_generated/logs/transcript.jsonl';
export const GEMINI_AGYHUB_FILE = 'agyhub_summaries_proto.pb';

export const ANTIGRAVITY_CLI_PLATFORM: SourcePlatform = 'antigravity-cli';
export const ANTIGRAVITY_IDE_PLATFORM: SourcePlatform = 'antigravity-ide';
