import { expect, test, describe } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { rmRecursive } from 'core/io/fs';
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

  test('discovers files matching the audit pattern and filters by mtime', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-discover-'));

    // Create matching audit file structures
    // * (org-1) / * (proj-1) / local_* (local_1) / audit.jsonl
    const auditDir1 = join(testDir, 'org-1', 'proj-1', 'local_1');
    const auditFile1 = join(auditDir1, 'audit.jsonl');
    await Bun.write(auditFile1, 'turn-1\n');

    // Create a second one with an older mtime or different path
    const auditDir2 = join(testDir, 'org-1', 'proj-2', 'local_2');
    const auditFile2 = join(auditDir2, 'audit.jsonl');
    await Bun.write(auditFile2, 'turn-2\n');

    // Create a non-matching file to ensure it's skipped
    const nonMatchingFile = join(testDir, 'org-1', 'proj-1', 'audit.jsonl');
    await Bun.write(nonMatchingFile, 'skip\n');

    // Test discovery without options
    const filesAll = await discoverClaudeDesktopFiles(testDir);
    expect(filesAll.length).toBe(2);
    const paths = filesAll.map((f) => f.sourcePath);
    expect(paths).toContain(auditFile1);
    expect(paths).toContain(auditFile2);
    expect(paths).not.toContain(nonMatchingFile);

    // Test filtering with minimumMtime
    const minMtime = new Date(Date.now() + 10_000); // 10s in the future
    const filesFiltered = await discoverClaudeDesktopFiles(testDir, {
      minimumMtime: minMtime,
    });
    expect(filesFiltered.length).toBe(0);

    await rmRecursive(testDir);
  });
});
