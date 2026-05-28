import { expect, test, describe } from 'bun:test';
import { openInMemoryBufferDb } from 'services/buffer/db.ts';
import { collectClaudeDesktopFile } from 'sources/claude-desktop';
import type { DiscoveredClaudeDesktopFile } from 'sources/claude-desktop';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmRecursive, statFile } from 'core/io/fs';

describe('collectClaudeDesktopFile', () => {
  test('returns zero batches when file size equals watermark', async () => {
    const db = openInMemoryBufferDb();

    // Create a clean, isolated test directory inside tmpdir
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
    const tempFile = join(testDir, 'audit.jsonl');

    await writeFile(
      tempFile,
      '{"type":"user","uuid":"123","message":{"role":"user","content":"hello"}}\n',
    );

    // Stat the temp file to get its real size
    const stat = await statFile(tempFile);
    if (!stat.exists) {
      throw new Error(`Test file not found: ${tempFile}`);
    }
    const size = stat.size;

    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash',
      inode: Number(stat.inode),
      sizeBytes: size,
      lastModifiedMs: Date.now(),
    };

    // First collection runs, processes the file, and sets the watermark
    let res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 1000,
    });

    expect(res.errors).toEqual([]);

    // Second collection: file size is equal to watermark, returns zero batches and zero errors
    res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 1000,
    });

    expect(res.capturedBatches).toBe(0);
    expect(res.errors).toEqual([]);

    db.close();
    await rmRecursive(testDir);
  });
});
