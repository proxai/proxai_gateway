import type { BodyCompression, BodyFormat, SourceApp, SourceKind } from 'services/contract';

export const CLAUDE_DESKTOP_SOURCE_APP: SourceApp = 'claude-desktop';
export const CLAUDE_DESKTOP_SOURCE_KIND: SourceKind = 'jsonl_append';
export const CLAUDE_DESKTOP_BODY_FORMAT: BodyFormat = 'jsonl';
export const CLAUDE_DESKTOP_BODY_COMPRESSION: BodyCompression = 'zstd';

export const CLAUDE_DESKTOP_SESSIONS_SUBPATH =
  'Library/Application Support/Claude/local-agent-mode-sessions';
export const CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN = '*/*/local_*/audit.jsonl';
export const CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN = '.claude/projects/*/*.jsonl';

export const CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION = 'unknown';
