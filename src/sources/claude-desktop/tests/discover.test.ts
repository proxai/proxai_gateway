import { expect, test, describe } from 'bun:test';
import { join } from 'node:path';
import {
  defaultClaudeDesktopSessionsRoot,
  discoverClaudeDesktopFiles,
} from 'sources/claude-desktop';

describe('discoverClaudeDesktopFiles', () => {
  test('resolves default sessions root', () => {
    const root = defaultClaudeDesktopSessionsRoot();
    const expected = join('Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
    expect(root).toContain(expected);
  });

  test('returns empty array when base directory does not exist', async () => {
    const res = await discoverClaudeDesktopFiles('/nonexistent/path/to/sessions');
    expect(res).toEqual([]);
  });
});
