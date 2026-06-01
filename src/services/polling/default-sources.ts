import {
  SOURCE_NAME_CLAUDE_CODE,
  SOURCE_NAME_CODEX,
  SOURCE_NAME_CURSOR,
  SOURCE_NAME_CLAUDE_DESKTOP,
} from 'services/polling/polling.constants.ts';
import type { RegisteredSource } from 'services/polling/polling.types.ts';
import { makeClaudeCodeSourcePoller } from 'services/polling/poll-claude-code.ts';
import { makeCodexSourcePoller } from 'services/polling/poll-codex.ts';
import { makeCursorSourcePoller } from 'services/polling/poll-cursor.ts';
import { makeClaudeDesktopSourcePoller } from 'services/polling/poll-claude-desktop.ts';

export interface DefaultSourcesOptions {
  claudeCodeBaseDir?: string;
  cursorBaseDir?: string;
  codexBaseDir?: string;
  claudeDesktopBaseDir?: string;
}

export function buildDefaultSources(options: DefaultSourcesOptions = {}): RegisteredSource[] {
  return [
    {
      name: SOURCE_NAME_CLAUDE_CODE,
      poll: makeClaudeCodeSourcePoller(buildPollerOptions(options.claudeCodeBaseDir)),
      ...(options.claudeCodeBaseDir !== undefined ? { baseDir: options.claudeCodeBaseDir } : {}),
    },
    {
      name: SOURCE_NAME_CURSOR,
      poll: makeCursorSourcePoller(buildPollerOptions(options.cursorBaseDir)),
      ...(options.cursorBaseDir !== undefined ? { baseDir: options.cursorBaseDir } : {}),
    },
    {
      name: SOURCE_NAME_CODEX,
      poll: makeCodexSourcePoller(buildPollerOptions(options.codexBaseDir)),
      ...(options.codexBaseDir !== undefined ? { baseDir: options.codexBaseDir } : {}),
    },
    {
      name: SOURCE_NAME_CLAUDE_DESKTOP,
      poll: makeClaudeDesktopSourcePoller(buildPollerOptions(options.claudeDesktopBaseDir)),
      ...(options.claudeDesktopBaseDir !== undefined
        ? { baseDir: options.claudeDesktopBaseDir }
        : {}),
    },
  ];
}

function buildPollerOptions(baseDir: string | undefined): { baseDir?: string } {
  const out: { baseDir?: string } = {};
  if (baseDir !== undefined) out.baseDir = baseDir;
  return out;
}
