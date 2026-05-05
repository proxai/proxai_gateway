import type { BodyCompression, BodyFormat, SourceApp, SourceKind } from 'services/contract';

export const CLAUDE_CODE_SOURCE_APP: SourceApp = 'claude-code';
export const CLAUDE_CODE_SOURCE_KIND: SourceKind = 'jsonl_append';
export const CLAUDE_CODE_BODY_FORMAT: BodyFormat = 'jsonl';
export const CLAUDE_CODE_BODY_COMPRESSION: BodyCompression = 'zstd';

export const CLAUDE_CODE_PROJECTS_SUBPATH = '.claude/projects';
export const CLAUDE_CODE_GLOB_PATTERN = '*/*.jsonl';

export const CLAUDE_CODE_DEFAULT_AGENT_SCHEMA_VERSION = 'unknown';
