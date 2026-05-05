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
}

export function buildDefaultSources(options: DefaultSourcesOptions = {}): RegisteredSource[] {
  return [
    {
      name: SOURCE_NAME_CLAUDE_CODE,
      poll: makeClaudeCodeSourcePoller(
        options.claudeCodeBaseDir !== undefined ? { baseDir: options.claudeCodeBaseDir } : {},
      ),
    },
    {
      name: SOURCE_NAME_CURSOR,
      poll: makeCursorSourcePoller(
        options.cursorBaseDir !== undefined ? { baseDir: options.cursorBaseDir } : {},
      ),
    },
    {
      name: SOURCE_NAME_CODEX,
      poll: makeCodexSourcePoller(
        options.codexBaseDir !== undefined ? { baseDir: options.codexBaseDir } : {},
      ),
    },
  ];
}
