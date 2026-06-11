import { expect, test, describe } from 'bun:test';
import { openInMemoryBufferDb } from 'services/buffer/db.ts';
import { getCursorWithFallback, nextPendingBatch } from 'services/buffer';
import { zstdDecompressSync, requireDefined } from 'core/utils';
import {
  CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION,
  collectClaudeDesktopFile,
} from 'sources/claude-desktop';
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

  test('correlates dialogue records with CLI transcripts and merges metadata', async () => {
    const db = openInMemoryBufferDb();
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));

    // Create a matching CLI transcript file structure
    const transcriptDir = join(testDir, '.claude', 'projects', 'p1');
    await Bun.write(join(transcriptDir, 'transcript.jsonl'), '');

    // Write CLI metadata into it
    const cliMetadataContent =
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-123',
          cwd: '/my/cwd',
          version: '1.2.3',
          gitBranch: 'main',
          sessionId: 'session-abc',
        }),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg-456' },
          cwd: '/my/cwd2',
          version: '1.2.4',
          gitBranch: 'feat',
          sessionId: 'session-def',
        }),
        // malformed line to test parsing error gracefully
        '{invalid json}',
        // empty line to test trim
        '',
      ].join('\n') + '\n';
    await writeFile(join(transcriptDir, 'transcript.jsonl'), cliMetadataContent);

    // Create the audit.jsonl file (File B)
    const tempFile = join(testDir, 'audit.jsonl');
    const auditContent =
      [
        // user record to correlate
        JSON.stringify({
          type: 'user',
          uuid: 'user-123',
          session_id: 'sess-1',
          client_platform: 'mac',
          message: { content: 'hello' },
        }),
        // assistant record to correlate
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg-456', content: 'hi' },
        }),
        // replay record to be skipped
        JSON.stringify({
          type: 'user',
          isReplay: true,
          uuid: 'user-123',
          message: { content: 'replay' },
        }),
        // non-dialogue record to be skipped
        JSON.stringify({
          type: 'other',
        }),
        // invalid json record to be skipped
        '{invalid json}',
        // empty line to be skipped
        '',
      ].join('\n') + '\n';
    await writeFile(tempFile, auditContent);

    const stat = (await statFile(tempFile)) as unknown as { inode: bigint; size: number };
    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash-desktop-collect',
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 10_000,
    });

    expect(res.errors).toEqual([]);
    expect(res.capturedBatches).toBe(1);
    expect(res.capturedBytes).toBeGreaterThan(0);

    db.close();
    await rmRecursive(testDir);
  });

  test('sets source_platform on the batch but not in the body, and bumps the schema version', async () => {
    const db = openInMemoryBufferDb();
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
    const tempFile = join(testDir, 'audit.jsonl');

    await writeFile(
      tempFile,
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        session_id: 'sess-1',
        client_platform: 'mac',
        message: { content: 'hello world' },
      }) + '\n',
    );

    const stat = (await statFile(tempFile)) as unknown as { inode: bigint; size: number };
    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash-platform',
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 10_000,
    });
    expect(res.errors).toEqual([]);
    expect(res.capturedBatches).toBe(1);

    const batch = requireDefined(nextPendingBatch(db));
    expect(batch.sourceApp).toBe('claude-desktop');
    expect(batch.sourcePlatform).toBe('claude-cowork-desktop');
    expect(batch.agentSchemaVersion).toBe(CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION);

    const body = new TextDecoder().decode(zstdDecompressSync(batch.body));
    expect(body).not.toContain('source_platform');

    db.close();
    await rmRecursive(testDir);
  });

  test('bumped default schema version is the v2 marker', () => {
    expect(CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION).toBe('claude-desktop/v2');
  });

  test('records errors on file read failure', async () => {
    const db = openInMemoryBufferDb();
    const fakeFile: DiscoveredClaudeDesktopFile = {
      sourcePath: join(tmpdir(), 'non-existent-desktop-audit.jsonl'),
      sourcePathHash: 'hash-non-existent',
      inode: 99999,
      sizeBytes: 100,
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(fakeFile, {
      buffer: db,
      maxDecompressedBytes: 1000,
    });

    expect(res.capturedBatches).toBe(0);
    expect(res.errors.length).toBe(1);
    const firstError = res.errors[0];
    expect(firstError).toBeDefined();
    if (firstError) {
      expect(firstError.reason).toContain('no such file');
    }

    db.close();
  });

  test('advances cursor and returns zero batches when no dialogue records are found', async () => {
    const db = openInMemoryBufferDb();
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
    const tempFile = join(testDir, 'audit.jsonl');

    // Only non-dialogue record
    await writeFile(tempFile, '{"type":"other"}\n');

    const stat = (await statFile(tempFile)) as unknown as { inode: bigint; size: number };
    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash-no-dialogue',
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 1000,
    });

    expect(res.capturedBatches).toBe(0);
    expect(res.errors).toEqual([]);

    const cursor = getCursorWithFallback(db, {
      sourceApp: 'claude-desktop',
      sourcePathHash: file.sourcePathHash,
      sourceInode: file.inode,
      watermarkTable: null,
    });
    expect(cursor?.watermarkEnd).toBe(stat.size);

    db.close();
    await rmRecursive(testDir);
  });

  test('returns zero batches and does not error if reading the file returns zero bytes', async () => {
    const db = openInMemoryBufferDb();
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
    const tempFile = join(testDir, 'audit.jsonl');

    await writeFile(tempFile, '{"type":"other"}\n');

    const stat = (await statFile(tempFile)) as unknown as { inode: bigint; size: number };
    // Truncate the file to 0 bytes
    await writeFile(tempFile, '');

    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash-zero-bytes',
      inode: Number(stat.inode),
      sizeBytes: stat.size, // positive size
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 1000,
    });

    expect(res.capturedBatches).toBe(0);
    expect(res.errors).toEqual([]);

    db.close();
    await rmRecursive(testDir);
  });
});
