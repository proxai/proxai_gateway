import {
  SOURCE_NAME_CLAUDE_CODE,
  SOURCE_NAME_CODEX,
  SOURCE_NAME_CURSOR,
} from 'services/polling/polling.constants.ts';
import type { RegisteredSource } from 'services/polling/polling.types.ts';
import { makeClaudeCodeSourcePoller } from 'services/polling/poll-claude-code.ts';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';
import { makeCursorSourcePoller } from 'services/polling/poll-cursor.ts';

export interface DefaultSourcesOptions {
  claudeCodeBaseDir?: string;
  cursorBaseDir?: string;
  codexBaseDir?: string;
  initialScanWindowDays?: number;
}

export function buildDefaultSources(options: DefaultSourcesOptions = {}): RegisteredSource[] {
  const window = options.initialScanWindowDays;
  return [
    {
      name: SOURCE_NAME_CLAUDE_CODE,
      poll: makeClaudeCodeSourcePoller(buildPollerOptions(options.claudeCodeBaseDir, window)),
    },
    {
      name: SOURCE_NAME_CURSOR,
      poll: makeCursorSourcePoller(buildPollerOptions(options.cursorBaseDir, window)),
    },
    {
      name: SOURCE_NAME_CODEX,
      poll: makeCodexSourcePoller(buildPollerOptions(options.codexBaseDir, window)),
    },
  ];
}

function buildPollerOptions(
  baseDir: string | undefined,
  initialScanWindowDays: number | undefined,
): { baseDir?: string; initialScanWindowDays?: number } {
  const out: { baseDir?: string; initialScanWindowDays?: number } = {};
  if (baseDir !== undefined) out.baseDir = baseDir;
  if (initialScanWindowDays !== undefined) out.initialScanWindowDays = initialScanWindowDays;
  return out;
}
