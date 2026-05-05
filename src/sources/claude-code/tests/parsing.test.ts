import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import { getCursor, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
import { collectClaudeCodeFile } from 'sources/claude-code';
import type { ClaudeCodeCollectorContext, DiscoveredClaudeCodeFile } from 'sources/claude-code';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const DECODER = new TextDecoder();

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-parsing-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

async function copyFixture(name: string, destName = name): Promise<DiscoveredClaudeCodeFile> {
  const src = join(FIXTURES_DIR, name);
  const dest = join(dir, destName);
  await copyFile(src, dest);
  const stat = await statFile(dest);
  if (!stat.exists) throw new Error(`fixture missing after copy: ${dest}`);
  return {
    sourcePath: dest,
    sourcePathHash: sha256Hex(dest),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}

function ctx(b: Database): ClaudeCodeCollectorContext {
  return { buffer: b, gatewayVersion: '@proxai/gateway 0.1.0' };
}

test('session-basic.jsonl: parses end-to-end and extracts message version from later lines', async () => {
  const file = await copyFixture('session-basic.jsonl');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);
  const batch = nextPendingBatch(buffer)!;
  expect(batch.agentSchemaVersion).toBe('2.1.122');
  expect(batch.sourceApp).toBe('claude-code');
  expect(batch.sourceKind).toBe('jsonl_append');
  expect(batch.bodyFormat).toBe('jsonl');
  expect(batch.bodyCompression).toBe('zstd');
});

test('session-basic.jsonl: redacts an OpenAI-shaped key in body', async () => {
  const file = await copyFixture('session-basic.jsonl');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  const decoded = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decoded).toContain('[REDACTED:openai-api-key]');
  expect(decoded).not.toContain('sk-FakeAbCdEfGhIj');
});

test('session-basic.jsonl: cursor advances to the end of the last newline', async () => {
  const file = await copyFixture('session-basic.jsonl');
  await collectClaudeCodeFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(file.sizeBytes);
});

test('session-trailing-partial.jsonl: holds back the unterminated last line', async () => {
  const file = await copyFixture('session-trailing-partial.jsonl');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  const decoded = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decoded.endsWith('\n')).toBe(true);
  expect(decoded).not.toContain('"partial');

  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBeLessThan(file.sizeBytes);
  const heldBackBytes = file.sizeBytes - (cursor?.watermarkEnd ?? 0);
  expect(heldBackBytes).toBeGreaterThan(0);
});

test('session-with-rotation: same path with new inode produces a fresh cursor', async () => {
  const fileA = await copyFixture('session-with-rotation.jsonl', 'session.jsonl');
  await collectClaudeCodeFile(fileA, ctx(buffer));
  const cursorA = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: fileA.sourcePathHash,
    sourceInode: fileA.inode,
    watermarkTable: null,
  });
  expect(cursorA?.watermarkEnd).toBe(fileA.sizeBytes);

  await rm(fileA.sourcePath, { force: true });
  const fileB = await copyFixture('session-with-rotation-continued.jsonl', 'session.jsonl');
  expect(fileB.inode).not.toBe(fileA.inode);
  expect(fileB.sourcePathHash).toBe(fileA.sourcePathHash);

  const result = await collectClaudeCodeFile(fileB, ctx(buffer));
  expect(result.capturedBatches).toBe(1);

  const cursorB = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: fileB.sourcePathHash,
    sourceInode: fileB.inode,
    watermarkTable: null,
  });
  expect(cursorB?.watermarkEnd).toBe(fileB.sizeBytes);

  const cursorAStillThere = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: fileA.sourcePathHash,
    sourceInode: fileA.inode,
    watermarkTable: null,
  });
  expect(cursorAStillThere?.watermarkEnd).toBe(fileA.sizeBytes);
});

test('session-with-rotation: agent_schema_version reflects the version found in each segment', async () => {
  const fileA = await copyFixture('session-with-rotation.jsonl', 'session.jsonl');
  await collectClaudeCodeFile(fileA, ctx(buffer));
  const batchA = nextPendingBatch(buffer)!;
  expect(batchA.agentSchemaVersion).toBe('2.1.100');
});
