import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import {
  countByStatus,
  deleteBatch,
  getCursor,
  nextPendingBatch,
  openInMemoryBufferDb,
  totalPendingBytes,
} from 'services/buffer';
import {
  BODY_MAX_COMPRESSED_BYTES,
  BODY_MAX_DECOMPRESSED_BYTES,
  BODY_TARGET_COMPRESSED_BYTES,
  BODY_TARGET_DECOMPRESSED_BYTES,
} from 'services/contract';
import { collectClaudeCodeFile } from 'sources/claude-code';
import type { ClaudeCodeCollectorContext, DiscoveredClaudeCodeFile } from 'sources/claude-code';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-collect-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeFile(
  content: string,
  name = 'session.jsonl',
): Promise<DiscoveredClaudeCodeFile> {
  const path = join(dir, name);
  await writeFile(path, content);
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}

function ctx(b: Database): ClaudeCodeCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

const DECODER = new TextDecoder();

test('inserts a batch covering newly added complete lines', async () => {
  const file = await makeFile('{"type":"user","message":{"version":"2.1.122"},"text":"hi"}\n');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(1);
  expect(totalPendingBytes(buffer)).toBeGreaterThan(0);
});

test('advances cursor to the safe end byte', async () => {
  const content = '{"a":1}\n{"b":2}\n';
  const file = await makeFile(content);
  await collectClaudeCodeFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});

test('does nothing on a second poll with no new bytes', async () => {
  const file = await makeFile('{"a":1}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const second = await collectClaudeCodeFile(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('holds back trailing partial line and only advances to last newline', async () => {
  const file = await makeFile('{"a":1}\n{"b":');
  await collectClaudeCodeFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe('{"a":1}\n'.length);
});

test('does not insert a batch when no complete line is present', async () => {
  const file = await makeFile('{"a":');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('extracts agent_schema_version from message.version', async () => {
  const file = await makeFile('{"type":"user","message":{"version":"2.1.122"},"text":"hi"}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('2.1.122');
});

test('falls back to "unknown" when message.version is missing', async () => {
  const file = await makeFile('{"type":"user","text":"hi"}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('unknown');
});

test('skips malformed JSON lines while scanning for version', async () => {
  const file = await makeFile(
    'this-line-is-not-json\n{"type":"user","text":"hi"}\n{"type":"assistant","version":"3.5.7"}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('3.5.7');
});

test('skips empty lines while scanning for version', async () => {
  const file = await makeFile('\n\n{"type":"user","version":"4.0.0"}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('4.0.0');
});

test('falls back when no parseable line carries a version', async () => {
  const file = await makeFile(
    'this-line-is-not-json\n{"type":"user","text":"hi"}\n{"type":"assistant","content":[]}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('unknown');
});

test('redacts secrets from the body before storing', async () => {
  const file = await makeFile(
    '{"type":"user","text":"export OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt"}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch).not.toBeNull();
  const decompressed = DECODER.decode(zstdDecompressSync(batch!.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('records errors and does not advance cursor when the file is unreadable', async () => {
  const fakeFile: DiscoveredClaudeCodeFile = {
    sourcePath: join(dir, 'does-not-exist.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.jsonl')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const result = await collectClaudeCodeFile(fakeFile, ctx(buffer));
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeFile('{"type":"user","message":{"version":"2.1.122"}}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.sourceApp).toBe('claude-code');
  expect(batch.sourceKind).toBe('jsonl_append');
  expect(batch.bodyFormat).toBe('jsonl');
  expect(batch.bodyCompression).toBe('zstd');
  expect(batch.watermarkKind).toBe('byte_range');
  expect(batch.watermarkTable).toBeNull();
  expect(batch.sourceInode).toBe(file.inode);
  expect(batch.gatewayVersion).toBe('@proxai/gateway 0.1.0');
  expect(batch.capturedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('splits an oversized slice into multiple batches with contiguous watermark coverage', async () => {
  const targetTotalLines = Math.ceil((3 * 1024 * 1024) / 2048);
  const linesArr: string[] = [];
  for (let i = 0; i < targetTotalLines; i++) {
    const noise = randomBytes(1500).toString('base64');
    linesArr.push(JSON.stringify({ i, noise }));
  }
  const content = `${linesArr.join('\n')}\n`;
  const file = await makeFile(content, 'big.jsonl');

  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  let prevEnd = 0;
  let scanned = 0;
  for (let i = 0; i < 50; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_TARGET_COMPRESSED_BYTES);
    expect(batch.watermarkStart).toBe(prevEnd);
    expect(batch.watermarkEnd).toBeGreaterThan(batch.watermarkStart);
    prevEnd = batch.watermarkEnd;
    scanned += 1;

    deleteBatch(buffer, batch.captureId);
  }
  expect(scanned).toBe(result.capturedBatches);

  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
  expect(prevEnd).toBe(content.length);
}, 30_000);

test('watermark continuity holds under redaction-induced byte-count changes', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    const longSecret = `sk-ant-${'A'.repeat(64)}`;
    lines.push(JSON.stringify({ i, key: longSecret, version: '2.1.122' }));
  }
  const content = `${lines.join('\n')}\n`;
  const file = await makeFile(content, 'redaction.jsonl');

  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);

  let prevEnd = 0;
  let totalCompressed = 0;
  let anyBodySmallerThanRange = false;
  for (let i = 0; i < 100; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.watermarkStart).toBe(prevEnd);
    expect(batch.watermarkEnd).toBeGreaterThan(batch.watermarkStart);
    const span = batch.watermarkEnd - batch.watermarkStart;
    if (batch.body.byteLength < span) anyBodySmallerThanRange = true;
    totalCompressed += batch.body.byteLength;
    prevEnd = batch.watermarkEnd;
    deleteBatch(buffer, batch.captureId);
  }

  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
  expect(prevEnd).toBe(content.length);
  expect(totalCompressed).toBeLessThan(content.length);
  expect(anyBodySmallerThanRange).toBe(true);
});

test('surfaces OversizedDecompressedSliceError when single line exceeds BODY_MAX_DECOMPRESSED_BYTES', async () => {
  const giantPayload = 'x'.repeat(BODY_MAX_DECOMPRESSED_BYTES + 1024);
  const oneLine = `${JSON.stringify({ giant: giantPayload, version: '2.1.122' })}\n`;
  const file = await makeFile(oneLine, 'oversized.jsonl');

  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  expect(result.errors[0]!.reason).toMatch(/decompressed slice/);
}, 30_000);

test('every batch satisfies BOTH compressed AND decompressed caps', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({ i, payload: 'x'.repeat(40), version: '2.1.122' }));
  }
  const content = `${lines.join('\n')}\n`;
  const file = await makeFile(content, 'invariant.jsonl');

  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);

  for (let i = 0; i < 100; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    const decoded = zstdDecompressSync(batch.body);
    expect(decoded.byteLength).toBeLessThanOrEqual(BODY_MAX_DECOMPRESSED_BYTES);
    deleteBatch(buffer, batch.captureId);
  }
});

test('resets watermark when source_inode changes (file rotated/replaced)', async () => {
  const file = await makeFile('{"a":1}\n');
  const first = await collectClaudeCodeFile(file, ctx(buffer));
  expect(first.capturedBatches).toBe(1);

  const newContent = '{"b":2}\n';
  await writeFile(file.sourcePath, newContent);
  const rotated = { ...file, inode: file.inode + 1, sizeBytes: newContent.length };

  const second = await collectClaudeCodeFile(rotated, ctx(buffer));
  expect(second.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(2);

  const cursorOld = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  const cursorNew = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: rotated.inode,
    watermarkTable: null,
  });
  expect(cursorOld?.watermarkEnd).toBe('{"a":1}\n'.length);
  expect(cursorNew?.watermarkEnd).toBe(newContent.length);
});
