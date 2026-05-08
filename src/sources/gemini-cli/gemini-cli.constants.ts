import type { BodyCompression, BodyFormat, SourceApp, SourceKind } from 'services/contract';

export const GEMINI_CLI_SOURCE_APP: SourceApp = 'gemini-cli';
export const GEMINI_CLI_SOURCE_KIND: SourceKind = 'jsonl_append';
export const GEMINI_CLI_BODY_FORMAT: BodyFormat = 'jsonl';
export const GEMINI_CLI_BODY_COMPRESSION: BodyCompression = 'zstd';

export const GEMINI_CLI_TMP_SUBPATH = '.gemini/tmp';
export const GEMINI_CLI_GLOB_PATTERN = '*/chats/**/*.jsonl';

export const GEMINI_CLI_DEFAULT_AGENT_SCHEMA_VERSION = 'gemini-cli/1';

export const GEMINI_CLI_HEADER_MAX_BYTES = 64 * 1024;
