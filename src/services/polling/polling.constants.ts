import type { SourceApp } from 'services/contract';

export const DEFAULT_POLL_INTERVAL_MS = 300_000;
export const MIN_POLL_INTERVAL_MS = 60_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;

export const CAPTURE_INTERVAL_MS = 2 * 60_000;
export const MIN_CAPTURE_INTERVAL_MS = 30_000;
export const MAX_CAPTURE_INTERVAL_MS = 30 * 60_000;

export const DRAIN_INTERVAL_MS = 30_000;
export const MIN_DRAIN_INTERVAL_MS = 5_000;
export const MAX_DRAIN_INTERVAL_MS = 5 * 60_000;

export const HEARTBEAT_INTERVAL_MS = 60 * 60_000;
export const MIN_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;

export const SOURCE_NAME_CLAUDE_CODE: SourceApp = 'claude-code';
export const SOURCE_NAME_CURSOR: SourceApp = 'cursor';
export const SOURCE_NAME_CODEX: SourceApp = 'codex';
export const SOURCE_NAME_GEMINI_CLI: SourceApp = 'gemini-cli';
