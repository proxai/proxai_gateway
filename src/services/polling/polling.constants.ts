import type { SourceApp } from 'services/contract';

export const DEFAULT_POLL_INTERVAL_MS = 300_000;

export const CAPTURE_INTERVAL_MS = 2 * 60_000;

export const DRAIN_INTERVAL_MS = 30_000;

export const HEARTBEAT_INTERVAL_MS = 60 * 60_000;

export const AUTH_RECOVERY_BASE_MS = 1_000;

export const AUTH_RECOVERY_MAX_RETRIES = 16;

export const AUTH_RECOVERY_IDLE_MS = 5_000;

export const SOURCE_NAME_CLAUDE_CODE: SourceApp = 'claude-code';
export const SOURCE_NAME_CURSOR: SourceApp = 'cursor';
export const SOURCE_NAME_CODEX: SourceApp = 'codex';
export const SOURCE_NAME_GEMINI_CLI: SourceApp = 'gemini-cli';
export const SOURCE_NAME_CLAUDE_DESKTOP: SourceApp = 'claude-desktop';
