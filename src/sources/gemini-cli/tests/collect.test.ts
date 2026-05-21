import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
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
import { collectGeminiCliFile, isGeminiCliDialogueRecord } from 'sources/gemini-cli';
import type { DiscoveredGeminiCliFile, GeminiCliCollectorContext } from 'sources/gemini-cli';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-cli-collect-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function makeFile(content: string, name = 'session.jsonl'): Promise<DiscoveredGeminiCliFile> {
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

function ctx(b: Database, detectedVersion: string | null = '0.41.2'): GeminiCliCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
    detectVersion: async () => detectedVersion,
  };
}

const DECODER = new TextDecoder();
const HEADER_MAIN = '{"sessionId":"abc","projectHash":"hex","kind":"main"}';
const HEADER_SUBAGENT = '{"sessionId":"abc","projectHash":"hex","kind":"subagent"}';
const EVENT_1 =
  '{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"hi"}]}';
const EVENT_2 =
  '{"id":"e2","timestamp":"2026-01-01T00:00:01Z","type":"assistant","content":[{"text":"hello"}]}';
const EVENT_3 =
  '{"id":"e3","timestamp":"2026-01-01T00:00:02Z","type":"tool_call","content":[{"text":"call"}]}';

test('first poll: header on line 1, three events on lines 2-4 produce one batch containing only dialogue rows', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n${EVENT_2}\n${EVENT_3}\n`);
  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(1);
  const batch = nextPendingBatch(buffer)!;
  const decoded = DECODER.decode(zstdDecompressSync(batch.body));
  const lines = decoded.split('\n').filter((l) => l.length > 0);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('"id":"e1"');
  expect(lines[1]).toContain('"id":"e2"');
  expect(totalPendingBytes(buffer)).toBeGreaterThan(0);
});

test('first poll: agent_schema_version uses prefix + detected installed package version', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n`);
  await collectGeminiCliFile(file, ctx(buffer, '0.41.2'));
  expect(nextPendingBatch(buffer)?.agentSchemaVersion).toBe('gemini-cli/0.41.2');
});

test('first poll: agent_schema_version is independent of header kind', async () => {
  const file = await makeFile(`${HEADER_SUBAGENT}\n${EVENT_1}\n`);
  await collectGeminiCliFile(file, ctx(buffer, '0.41.2'));
  expect(nextPendingBatch(buffer)?.agentSchemaVersion).toBe('gemini-cli/0.41.2');
});

test('first poll: agent_schema_version falls back to default when version detection returns null', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n`);
  await collectGeminiCliFile(file, ctx(buffer, null));
  expect(nextPendingBatch(buffer)?.agentSchemaVersion).toBe('gemini-cli/unknown');
});

test('first poll: cursor advances past header + emitted events', async () => {
  const content = `${HEADER_MAIN}\n${EVENT_1}\n${EVENT_2}\n`;
  const file = await makeFile(content);
  await collectGeminiCliFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});

test('first poll: header-only file (no events yet) advances cursor to header end without emitting a batch', async () => {
  const content = `${HEADER_MAIN}\n`;
  const file = await makeFile(content);
  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});

test('first poll: file without any newline yet (still writing header) is a no-op', async () => {
  const content = HEADER_MAIN.slice(0, 20);
  const file = await makeFile(content);
  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor).toBeNull();
});

test('subsequent poll: no new bytes returns a no-op', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n`);
  await collectGeminiCliFile(file, ctx(buffer));
  const second = await collectGeminiCliFile(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('subsequent poll: appended event captured without re-reading the header', async () => {
  const initial = `${HEADER_MAIN}\n${EVENT_1}\n${EVENT_2}\n${EVENT_3}\n`;
  const file = await makeFile(initial);
  await collectGeminiCliFile(file, ctx(buffer));

  const appended = `${initial}${EVENT_1}\n`;
  await writeFile(file.sourcePath, appended);
  const stat = await statFile(file.sourcePath);
  const file2: DiscoveredGeminiCliFile = {
    ...file,
    sizeBytes: stat.exists ? stat.size : appended.length,
  };
  const result = await collectGeminiCliFile(file2, ctx(buffer));
  expect(result.capturedBatches).toBe(1);

  const batches: ReturnType<typeof nextPendingBatch>[] = [];
  for (let i = 0; i < 5; i++) {
    const b = nextPendingBatch(buffer);
    if (b === null) break;
    batches.push(b);
    deleteBatch(buffer, b.captureId);
  }
  expect(batches).toHaveLength(2);
  const second = batches[1]!;
  const decoded = DECODER.decode(zstdDecompressSync(second.body));
  const lines = decoded.split('\n').filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"id":"e1"');
  expect(second.agentSchemaVersion).toBe('gemini-cli/0.41.2');
});

test('subsequent poll: agent_schema_version reflects detected version on each poll', async () => {
  const initial = `${HEADER_SUBAGENT}\n${EVENT_1}\n`;
  const file = await makeFile(initial);
  await collectGeminiCliFile(file, ctx(buffer, '0.41.2'));
  const firstBatch = nextPendingBatch(buffer)!;
  deleteBatch(buffer, firstBatch.captureId);

  const appended = `${initial}${EVENT_2}\n`;
  await writeFile(file.sourcePath, appended);
  const stat = await statFile(file.sourcePath);
  const file2: DiscoveredGeminiCliFile = {
    ...file,
    sizeBytes: stat.exists ? stat.size : appended.length,
  };
  await collectGeminiCliFile(file2, ctx(buffer, '0.42.0'));
  const secondBatch = nextPendingBatch(buffer)!;
  expect(secondBatch.agentSchemaVersion).toBe('gemini-cli/0.42.0');
});

test('uses default detector when context.detectVersion is omitted', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n`);
  const result = await collectGeminiCliFile(file, {
    buffer,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  });
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);
  const batch = nextPendingBatch(buffer)!;
  expect(batch.agentSchemaVersion).toMatch(/^gemini-cli\//);
});

test('holds back trailing partial line and only advances to last newline', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n${EVENT_2.slice(0, 10)}`);
  await collectGeminiCliFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(`${HEADER_MAIN}\n${EVENT_1}\n`.length);
});

test('redacts secrets from event content before storing', async () => {
  const evt = `{"id":"e1","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"export OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt"}]}`;
  const file = await makeFile(`${HEADER_MAIN}\n${evt}\n`);
  await collectGeminiCliFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('records errors and does not advance cursor when the file is unreadable', async () => {
  const fakeFile: DiscoveredGeminiCliFile = {
    sourcePath: join(dir, 'does-not-exist.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.jsonl')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const result = await collectGeminiCliFile(fakeFile, ctx(buffer));
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeFile(`${HEADER_MAIN}\n${EVENT_1}\n`);
  await collectGeminiCliFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.sourceApp).toBe('gemini-cli');
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
  const linesArr: string[] = [HEADER_MAIN];
  for (let i = 0; i < targetTotalLines; i++) {
    const noise = randomBytes(1500).toString('base64');
    linesArr.push(JSON.stringify({ id: `e${i.toString()}`, type: 'user', noise }));
  }
  const content = `${linesArr.join('\n')}\n`;
  const file = await makeFile(content, 'big.jsonl');

  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  let prevEnd = `${HEADER_MAIN}\n`.length;
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
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
  expect(prevEnd).toBe(content.length);
}, 30_000);

test('surfaces OversizedDecompressedSliceError when single line exceeds BODY_MAX_DECOMPRESSED_BYTES', async () => {
  const giantPayload = 'x'.repeat(BODY_MAX_DECOMPRESSED_BYTES + 1024);
  const oneLine = JSON.stringify({ id: 'g', type: 'user', giant: giantPayload });
  const file = await makeFile(`${HEADER_MAIN}\n${oneLine}\n`, 'oversized.jsonl');

  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  expect(result.errors[0]!.reason).toMatch(/decompressed slice/);
}, 30_000);

test('subsequent poll where appended bytes lack a newline is a no-op (partial trailing line)', async () => {
  const initial = `${HEADER_MAIN}\n${EVENT_1}\n`;
  const file = await makeFile(initial);
  await collectGeminiCliFile(file, ctx(buffer));
  const firstBatch = nextPendingBatch(buffer)!;
  deleteBatch(buffer, firstBatch.captureId);

  const appended = `${initial}{"id":"e2","timestamp":"2026-01-01T0`;
  await writeFile(file.sourcePath, appended);
  const stat = await statFile(file.sourcePath);
  const file2: DiscoveredGeminiCliFile = {
    ...file,
    sizeBytes: stat.exists ? stat.size : appended.length,
  };
  const result = await collectGeminiCliFile(file2, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(initial.length);
});

test('every batch satisfies BOTH compressed AND decompressed caps', async () => {
  const lines: string[] = [HEADER_MAIN];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({ id: `e${i.toString()}`, type: 'user', payload: 'x'.repeat(40) }));
  }
  const content = `${lines.join('\n')}\n`;
  const file = await makeFile(content, 'invariant.jsonl');

  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThan(0);

  for (let i = 0; i < 100; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    const decoded = zstdDecompressSync(batch.body);
    expect(decoded.byteLength).toBeLessThanOrEqual(BODY_MAX_DECOMPRESSED_BYTES);
    deleteBatch(buffer, batch.captureId);
  }
});

test('isGeminiCliDialogueRecord validation', () => {
  expect(isGeminiCliDialogueRecord(null)).toBe(false);
  expect(isGeminiCliDialogueRecord(undefined)).toBe(false);
  expect(isGeminiCliDialogueRecord(42)).toBe(false);
  expect(isGeminiCliDialogueRecord('string')).toBe(false);
  expect(isGeminiCliDialogueRecord({})).toBe(false);
  expect(isGeminiCliDialogueRecord({ type: 'user' })).toBe(true);
  expect(isGeminiCliDialogueRecord({ type: 'assistant' })).toBe(true);
  expect(isGeminiCliDialogueRecord({ type: 'tool_call' })).toBe(false);
  expect(isGeminiCliDialogueRecord({ type: 'tool_response' })).toBe(false);
  expect(isGeminiCliDialogueRecord({ type: 'system' })).toBe(false);
});

test('first poll: file with only non-dialogue events advances cursor past them but emits zero batches', async () => {
  const content = `${HEADER_MAIN}\n${EVENT_3}\n`;
  const file = await makeFile(content);
  const result = await collectGeminiCliFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini-cli',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});
