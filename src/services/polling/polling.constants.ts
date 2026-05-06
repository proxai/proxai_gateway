import type { SourceApp } from 'services/contract';

export const DEFAULT_POLL_INTERVAL_MS = 300_000;
export const MIN_POLL_INTERVAL_MS = 60_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;

export const SOURCE_NAME_CLAUDE_CODE: SourceApp = 'claude-code';
export const SOURCE_NAME_CURSOR: SourceApp = 'cursor';
export const SOURCE_NAME_CODEX: SourceApp = 'codex';
