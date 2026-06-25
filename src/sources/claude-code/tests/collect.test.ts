import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync, requireDefined } from 'core/utils';
import {
  countByStatus,
  deleteBatch,
  getCursor,
  nextPendingBatch,
  openInMemoryBufferDb,
  setCursor,
  totalPendingBytes,
} from 'services/buffer';
import {
  BODY_MAX_COMPRESSED_BYTES,
  BODY_MAX_DECOMPRESSED_BYTES,
  BODY_TARGET_COMPRESSED_BYTES,
  BODY_TARGET_DECOMPRESSED_BYTES,
} from 'services/contract';
import {
  collectClaudeCodeFile,
  deriveClaudeCodeSessionId,
  isDialogueRecord,
  claudeFirstText,
  slimClaudeUsageRecord,
} from 'sources/claude-code';
import type { ClaudeCodeCollectorContext, DiscoveredClaudeCodeFile } from 'sources/claude-code';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-collect-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
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
  const content =
    '{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"role":"assistant","content":"hello"}}\n';
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
  const file = await makeFile('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  await collectClaudeCodeFile(file, ctx(buffer));
  const second = await collectClaudeCodeFile(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('holds back trailing partial line and only advances to last newline', async () => {
  const file = await makeFile(
    '{"type":"user","message":{"role":"user","content":"a"}}\n{"type":"user","message":{"role":"user","content":',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(
    '{"type":"user","message":{"role":"user","content":"a"}}\n'.length,
  );
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
    'this-line-is-not-json\n{"type":"user","text":"hi"}\n{"type":"assistant","version":"3.5.7","text":"hello"}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('3.5.7');
});

test('skips empty lines while scanning for version', async () => {
  const file = await makeFile('\n\n{"type":"user","version":"4.0.0","text":"hello"}\n');
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
  const decompressed = DECODER.decode(zstdDecompressSync(requireDefined(batch).body));
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

test('increments consecutive_errors on per-file collector failure', async () => {
  const fakeFile: DiscoveredClaudeCodeFile = {
    sourcePath: join(dir, 'does-not-exist-2.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist-2.jsonl')),
    inode: 8888,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  setCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: fakeFile.sourcePathHash,
    sourcePath: fakeFile.sourcePath,
    sourceInode: fakeFile.inode,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 2,
  });
  await collectClaudeCodeFile(fakeFile, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: fakeFile.sourcePathHash,
    sourceInode: fakeFile.inode,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(3);
});

test('resets consecutive_errors on success after prior failure', async () => {
  const file = await makeFile('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  setCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: file.inode,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 5,
  });
  await collectClaudeCodeFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeFile(
    '{"type":"user","message":{"version":"2.1.122","role":"user","content":"hi"}}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
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
  const targetTotalLines = 20;
  const linesArr: string[] = [];
  for (let i = 0; i < targetTotalLines; i++) {
    const noise = randomBytes(1000).toString('base64');
    linesArr.push(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: noise },
        version: '2.1.122',
      }),
    );
  }
  const content = `${linesArr.join('\n')}\n`;
  const file = await makeFile(content, 'big.jsonl');

  const loggedInfos: Array<{ obj: unknown; msg: string }> = [];
  const loggedDebugs: Array<{ obj: unknown; msg: string }> = [];
  const mockLogger = {
    info: (obj: unknown, msg: string) => {
      loggedInfos.push({ obj, msg });
    },
    debug: (obj: unknown, msg: string) => {
      loggedDebugs.push({ obj, msg });
    },
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => mockLogger,
  };

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
    logger: mockLogger,
  };
  const result = await collectClaudeCodeFile(file, customCtx);
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);
  expect(loggedInfos.length).toBeGreaterThan(0);
  expect(loggedDebugs.length).toBeGreaterThan(0);

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
    lines.push(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: longSecret },
        version: '2.1.122',
      }),
    );
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

test('surfaces OversizedDecompressedSliceError when single line exceeds maxDecompressedBytes', async () => {
  const giantPayload = 'x'.repeat(20_000);
  const oneLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: giantPayload }, version: '2.1.122' })}\n`;
  const file = await makeFile(oneLine, 'oversized.jsonl');

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const result = await collectClaudeCodeFile(file, customCtx);
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  expect(requireDefined(result.errors[0]).reason).toMatch(/decompressed slice/);
}, 30_000);

test('every batch satisfies BOTH compressed AND decompressed caps', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'x'.repeat(40) },
        version: '2.1.122',
      }),
    );
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
  const file = {
    ...(await makeFile('{"type":"user","message":{"role":"user","content":"a"}}\n')),
    inode: 1001,
  };
  const first = await collectClaudeCodeFile(file, ctx(buffer));
  expect(first.capturedBatches).toBe(1);

  const newContent = '{"type":"user","message":{"role":"user","content":"b"}}\n';
  await writeFile(file.sourcePath, newContent);
  const rotated = { ...file, inode: 1002, sizeBytes: newContent.length };

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
  expect(cursorOld?.watermarkEnd).toBe(
    '{"type":"user","message":{"role":"user","content":"a"}}\n'.length,
  );
  expect(cursorNew?.watermarkEnd).toBe(newContent.length);
});

test('isDialogueRecord extreme inputs and edge cases', () => {
  expect(isDialogueRecord(null)).toBe(false);
  expect(isDialogueRecord(undefined)).toBe(false);
  expect(isDialogueRecord({})).toBe(false);
  expect(isDialogueRecord(123)).toBe(false);
  expect(isDialogueRecord('string')).toBe(false);
  expect(isDialogueRecord({ type: 'other' })).toBe(false);

  expect(isDialogueRecord({ type: 'user' })).toBe(false);
  expect(isDialogueRecord({ type: 'user', message: null })).toBe(false);
  expect(isDialogueRecord({ type: 'user', message: {} })).toBe(false);
  expect(isDialogueRecord({ type: 'user', message: { content: null } })).toBe(false);
  expect(isDialogueRecord({ type: 'user', message: { content: 'hello' } })).toBe(true);
  expect(isDialogueRecord({ type: 'user', message: { content: 123 } })).toBe(true);

  expect(isDialogueRecord({ type: 'user', message: { content: { type: 'tool_result' } } })).toBe(
    false,
  );
  expect(isDialogueRecord({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(
    false,
  );
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: [null, undefined, { type: 'tool_result' }] },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: [null, { type: 'text', text: 'hello' }] },
    }),
  ).toBe(true);
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: [{ type: 'image' }, { type: 'text', text: 'hello' }] },
    }),
  ).toBe(true);

  expect(isDialogueRecord({ type: 'user', content: { type: 'tool_result' } })).toBe(false);
  expect(isDialogueRecord({ type: 'user', content: [{ type: 'tool_result' }] })).toBe(false);
  expect(
    isDialogueRecord({ type: 'user', content: [null, undefined, { type: 'tool_result' }] }),
  ).toBe(false);
  expect(isDialogueRecord({ type: 'user', content: [null, { type: 'text', text: 'hello' }] })).toBe(
    true,
  );

  expect(isDialogueRecord({ type: 'assistant' })).toBe(false);
  expect(isDialogueRecord({ type: 'assistant', message: null })).toBe(false);
  expect(isDialogueRecord({ type: 'assistant', message: {} })).toBe(false);
  expect(isDialogueRecord({ type: 'assistant', message: { content: null } })).toBe(false);
  expect(isDialogueRecord({ type: 'assistant', message: { content: 'hello' } })).toBe(true);
  expect(isDialogueRecord({ type: 'assistant', message: { content: 123 } })).toBe(true);

  expect(isDialogueRecord({ type: 'assistant', message: { content: { type: 'tool_use' } } })).toBe(
    false,
  );
  expect(
    isDialogueRecord({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'assistant',
      message: { content: [null, undefined, { type: 'tool_use' }] },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'assistant',
      message: { content: [null, { type: 'text', text: 'hello' }] },
    }),
  ).toBe(true);

  expect(isDialogueRecord({ type: 'assistant', content: { type: 'tool_use' } })).toBe(false);
  expect(isDialogueRecord({ type: 'assistant', content: [{ type: 'tool_use' }] })).toBe(false);
  expect(
    isDialogueRecord({ type: 'assistant', content: [null, undefined, { type: 'tool_use' }] }),
  ).toBe(false);
  expect(
    isDialogueRecord({ type: 'assistant', content: [null, { type: 'text', text: 'hello' }] }),
  ).toBe(true);

  expect(
    isDialogueRecord({ type: 'user', message: { content: [[{ type: 'tool_result' }]] } }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: Array(10000).fill({ type: 'text', text: 'hello' }) },
    }),
  ).toBe(true);
  expect(
    isDialogueRecord({
      type: 'user',
      message: {
        content: [...Array(10000).fill({ type: 'text', text: 'hello' }), { type: 'tool_result' }],
      },
    }),
  ).toBe(false);
});

test('extracts first text segment when dealing with diverse input structures', () => {
  expect(claudeFirstText([])).toBe('');
});

test('handles metadata-marked records by rejecting them', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      isMeta: true,
      message: { content: 'hello' },
    }),
  ).toBe(false);
});

test('identifies and filters synthetic user prompt items', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: '<bash-input> ls' },
    }),
  ).toBe(false);
});

test('excludes synthetic models and error messages for assistant records', () => {
  expect(
    isDialogueRecord({
      type: 'assistant',
      message: { content: 'hello', model: '<synthetic>' },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { content: 'hello' },
    }),
  ).toBe(false);
});

test('filters out messages containing non-array object tool results or text elements', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: { type: 'text', text: 'hello' } },
    }),
  ).toBe(true);
});

test('advances cursor and returns zero batches when no dialogue records are found', async () => {
  const file = await makeFile('{"type":"user","message":{"content":[]}}\n');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBeGreaterThan(0);
});

test('collectClaudeCodeFile handles non-Error exception gracefully', async () => {
  const fakeFile: DiscoveredClaudeCodeFile = {
    sourcePath: join(dir, 'test-non-error.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'test-non-error.jsonl')),
    inode: 7777,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };

  const fakeDb = bridgeDatabase({
    query: () => {
      throw 'database string exception';
    },
  });

  const result = await collectClaudeCodeFile(fakeFile, {
    ...ctx(buffer),
    buffer: fakeDb,
  });

  expect(result.errors.length).toBe(1);
  expect(requireDefined(result.errors[0]).reason).toBe('database string exception');
});

test('isDialogueRecord with non-string, non-array, non-object actualContent (number)', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: 123 },
    }),
  ).toBe(true);
});

test('isDialogueRecord with array content containing null or non-object', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: [null] },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: ['hello'] },
    }),
  ).toBe(false);
});

test('claudeFirstText with non-text object returns empty string', () => {
  expect(claudeFirstText({ type: 'tool_use' })).toBe('');
});

test('isDialogueRecord covers all permutations of actualContent extraction', () => {
  expect(isDialogueRecord({ type: 'user', content: 'hello' })).toBe(true);
  expect(isDialogueRecord({ type: 'user', message: { text: 'hello' } })).toBe(true);
  expect(isDialogueRecord({ type: 'user', text: 'hello' })).toBe(true);
});

test('claudeFirstText extra edge cases', () => {
  expect(claudeFirstText({ type: 'text', text: 123 })).toBe('');
  expect(claudeFirstText(null)).toBe('');
  expect(claudeFirstText(undefined)).toBe('');
});

test('isDialogueRecord extra array content edge cases', () => {
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: [{ type: 'tool_use' }] },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'user',
      message: { content: null },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      text: 'hello',
    }),
  ).toBe(false);
});

test('extractAgentSchemaVersion with empty string version', async () => {
  const file = await makeFile('{"type":"user","version":"","text":"hi"}\n');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
});

test('extractAgentSchemaVersion with empty string nested version', async () => {
  const file = await makeFile('{"type":"user","message":{"version":""},"text":"hi"}\n');
  const result = await collectClaudeCodeFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
});

test('extractAgentSchemaVersion falls back when redaction yields invalid JSON', async () => {
  const file = await makeFile(
    '{"type":"user","message":{"content":"password: aaaaaaaaaaaaaaaaaaaaaaaa"},"version":"9.9.9"}\n',
  );
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('unknown');
});

test('tags claude-code-cli when the session id is not in the desktop set', async () => {
  const file = await makeFile('{"type":"user","message":{"content":"hi"}}\n', 'cli-session.jsonl');
  const result = await collectClaudeCodeFile(file, {
    ...ctx(buffer),
    desktopCliSessionIds: new Set(['some-other-id']),
  });
  expect(result.capturedBatches).toBe(1);
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourceApp).toBe('claude-code');
  expect(batch.sourcePlatform).toBe('claude-code-cli');
});

test('tags claude-code-desktop when the session id is in the desktop set', async () => {
  const file = await makeFile(
    '{"type":"user","message":{"content":"hi"}}\n',
    'desktop-session.jsonl',
  );
  const result = await collectClaudeCodeFile(file, {
    ...ctx(buffer),
    desktopCliSessionIds: new Set(['desktop-session']),
  });
  expect(result.capturedBatches).toBe(1);
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('claude-code-desktop');
});

test('defaults to claude-code-cli when no desktop set is provided', async () => {
  const file = await makeFile('{"type":"user","message":{"content":"hi"}}\n', 'no-set.jsonl');
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('claude-code-cli');
});

test('deriveClaudeCodeSessionId uses the filename for a top-level transcript', () => {
  expect(deriveClaudeCodeSessionId(join('a', 'b', 'sess-123.jsonl'))).toBe('sess-123');
});

test('deriveClaudeCodeSessionId uses the parent session dir for a subagent transcript', () => {
  const subagentPath = join('proj', 'sess-abc', 'subagents', 'agent-deadbeef.jsonl');
  expect(deriveClaudeCodeSessionId(subagentPath)).toBe('sess-abc');
});

test('subagent transcript inherits its parent session desktop classification', async () => {
  const subDir = join(dir, 'sess-xyz', 'subagents');
  await Bun.write(join(subDir, 'agent-1.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
  const sourcePath = join(subDir, 'agent-1.jsonl');
  const stat = await statFile(sourcePath);
  if (!stat.exists) throw new Error('subagent file missing');
  const file: DiscoveredClaudeCodeFile = {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  await collectClaudeCodeFile(file, {
    ...ctx(buffer),
    desktopCliSessionIds: new Set(['sess-xyz']),
  });
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('claude-code-desktop');
});

function bridgeDatabase(db: unknown): Database {
  return db as unknown as Database;
}

test('pauses an excluded session: inserts nothing AND leaves the watermark unchanged', async () => {
  const content =
    '{"type":"user","cwd":"/Users/me/secret","message":{"role":"user","content":"hi"}}\n';
  const file = await makeFile(content);
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];

  const result = await collectClaudeCodeFile(file, c);

  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  // PAUSE: no cursor row created (watermark NOT advanced) — so it backfills later.
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd ?? 0).toBe(0);
});

test('captures a non-excluded session normally', async () => {
  const content =
    '{"type":"user","cwd":"/Users/me/keep","message":{"role":"user","content":"hi"}}\n';
  const file = await makeFile(content);
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];
  const result = await collectClaudeCodeFile(file, c);
  expect(result.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('fail-open: a session with no cwd is captured even with an exclusion list', async () => {
  const content = '{"type":"user","message":{"role":"user","content":"hi"}}\n';
  const file = await makeFile(content);
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];
  const result = await collectClaudeCodeFile(file, c);
  expect(result.capturedBatches).toBe(1);
});

test('backfills when a project is removed from the exclusion list (no cursor reset needed)', async () => {
  const content =
    '{"type":"user","cwd":"/Users/me/secret","message":{"role":"user","content":"hi"}}\n';
  const file = await makeFile(content);

  // Cycle 1: excluded -> nothing captured, watermark frozen at 0.
  const excludedCtx = ctx(buffer);
  excludedCtx.excludedProjects = ['/Users/me/secret'];
  await collectClaudeCodeFile(file, excludedCtx);
  expect(countByStatus(buffer).pending).toBe(0);

  // Cycle 2: no longer excluded -> backfills from byte 0.
  const openCtx = ctx(buffer);
  openCtx.excludedProjects = [];
  const result = await collectClaudeCodeFile(file, openCtx);
  expect(result.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('pauses an excluded subagent transcript (top-level cwd is honored)', async () => {
  const subDir = join(dir, 'sess-excl', 'subagents');
  await Bun.write(
    join(subDir, 'agent-1.jsonl'),
    '{"type":"user","cwd":"/Users/me/secret","message":{"role":"user","content":"hi"}}\n',
  );
  const sourcePath = join(subDir, 'agent-1.jsonl');
  const stat = await statFile(sourcePath);
  if (!stat.exists) throw new Error('subagent file missing');
  const file: DiscoveredClaudeCodeFile = {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];
  const result = await collectClaudeCodeFile(file, c);
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  // Subagent transcripts carry a top-level cwd, so the gate fires; watermark stays frozen (PAUSE).
  const cursor = getCursor(buffer, {
    sourceApp: 'claude-code',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd ?? 0).toBe(0);
});

test('slimClaudeUsageRecord projects a usage-bearing tool_use record to a closed usage-only shape', () => {
  const rec = {
    parentUuid: '66',
    type: 'assistant',
    uuid: 'a-uuid',
    sessionId: 's-id',
    timestamp: '2026-01-01T00:00:03.000Z',
    requestId: 'req_bbbb',
    message: {
      id: 'msg_bbbb',
      model: 'claude-fake-1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/tmp/x' } }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
        extraneous: 'DROP_ME',
      },
    },
  };
  expect(slimClaudeUsageRecord(rec)).toEqual({
    type: 'assistant',
    sessionId: 's-id',
    uuid: 'a-uuid',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: {
      model: 'claude-fake-1',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
  });
});

test('slimClaudeUsageRecord drops unknown usage fields (closed shape — no passthrough)', () => {
  const slim = slimClaudeUsageRecord({
    type: 'assistant',
    sessionId: 's',
    uuid: 'u',
    message: { usage: { input_tokens: 5, junk: { huge: 'x'.repeat(99) } } },
  });
  expect(slim).toEqual({
    type: 'assistant',
    sessionId: 's',
    uuid: 'u',
    message: { usage: { input_tokens: 5 } },
  });
});

test('slimClaudeUsageRecord returns null for records with no recoverable usage', () => {
  expect(
    slimClaudeUsageRecord({
      type: 'user',
      sessionId: 's',
      uuid: 'u',
      message: { content: [{ type: 'tool_result' }] },
    }),
  ).toBeNull();
  expect(
    slimClaudeUsageRecord({
      type: 'assistant',
      sessionId: 's',
      uuid: 'u',
      message: { model: '<synthetic>', usage: { input_tokens: 1 } },
    }),
  ).toBeNull();
  expect(
    slimClaudeUsageRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      sessionId: 's',
      uuid: 'u',
      message: { usage: { input_tokens: 1 } },
    }),
  ).toBeNull();
  expect(
    slimClaudeUsageRecord({ type: 'assistant', sessionId: 's', uuid: 'u', message: {} }),
  ).toBeNull();
  expect(
    slimClaudeUsageRecord({ type: 'assistant', message: { usage: { input_tokens: 1 } } }),
  ).toBeNull();
  expect(slimClaudeUsageRecord(null)).toBeNull();
});

test('recovers usage-bearing tool_use records as slim projections; strips content; nest-parseable', async () => {
  const user =
    '{"type":"user","promptId":"p1","message":{"role":"user","content":"hi"},"uuid":"u1","sessionId":"s1","version":"2.1.122"}';
  const toolUse =
    '{"type":"assistant","message":{"model":"claude-fake-1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/secret-path.txt"}}],"usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":100,"cache_read_input_tokens":0}},"uuid":"u2","sessionId":"s1","timestamp":"2026-01-01T00:00:03.000Z"}';
  const toolResult =
    '{"type":"user","promptId":"p1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"BULKY FILE CONTENTS"}]},"uuid":"u2b","sessionId":"s1"}';
  const finalText =
    '{"type":"assistant","message":{"model":"claude-fake-1","role":"assistant","content":[{"type":"text","text":"all done"}],"usage":{"input_tokens":2,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":45000}},"uuid":"u3","sessionId":"s1","timestamp":"2026-01-01T00:00:04.000Z"}';
  const content = [user, toolUse, toolResult, finalText].join('\n') + '\n';
  const file = await makeFile(content);
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  const body = DECODER.decode(zstdDecompressSync(batch.body));

  // recovery: the tool_use call's usage reaches the body (fail-before/pass-after discriminator)
  expect(body).toContain('"input_tokens":3');
  // content stripped (LOAD-BEARING: secret-path.txt + tool name live ONLY in tool_use content)
  expect(body).not.toContain('"name":"Read"');
  expect(body).not.toContain('secret-path.txt');
  // tool_result (no usage) stays dropped
  expect(body).not.toContain('BULKY FILE CONTENTS');
  // dialogue retained
  expect(body).toContain('all done');

  // nest-parseability guard: the recovered line satisfies parseClaudeCodeLine's required keys
  const slimLine = requireDefined(body.split('\n').find((l) => l.includes('"input_tokens":3')));
  const parsedSlim = JSON.parse(slimLine);
  expect(typeof parsedSlim.type).toBe('string');
  expect(typeof parsedSlim.sessionId).toBe('string');
  expect(typeof parsedSlim.uuid).toBe('string');
  expect(parsedSlim.promptId).toBeUndefined(); // must NOT open a new turn
  expect(parsedSlim.message.content).toBeUndefined(); // content stripped
});

test('slim records survive the oversized-split path with watermark continuity and no dup/drop', async () => {
  const user =
    '{"type":"user","promptId":"p1","message":{"role":"user","content":"go"},"uuid":"u0","sessionId":"s1","version":"2.1.122"}';
  const toolUses: string[] = [];
  for (let i = 0; i < 40; i++) {
    toolUses.push(
      `{"type":"assistant","message":{"model":"m","role":"assistant","content":[{"type":"tool_use","id":"t${i}","name":"Read","input":{"file_path":"/tmp/${'p'.repeat(800)}-${i}"}}],"usage":{"input_tokens":${i + 1},"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"u${i}","sessionId":"s1"}`,
    );
  }
  const content = [user, ...toolUses].join('\n') + '\n';
  const file = await makeFile(content, 'split.jsonl');
  const result = await collectClaudeCodeFile(file, { ...ctx(buffer), maxDecompressedBytes: 4000 });
  expect(result.errors).toEqual([]);
  let prevEnd = 0;
  const seenInputs = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.watermarkStart).toBe(prevEnd);
    prevEnd = batch.watermarkEnd;
    for (const line of DECODER.decode(zstdDecompressSync(batch.body)).split('\n')) {
      const m = line.match(/"input_tokens":(\d+)/);
      const tok = m?.[1];
      if (tok !== undefined) {
        expect(seenInputs.has(tok)).toBe(false);
        seenInputs.add(tok);
      } // each exactly once
    }
    deleteBatch(buffer, batch.captureId);
  }
  expect(prevEnd).toBe(content.length); // full coverage, no gap
});

test('slimClaudeUsageRecord ignores content on a MIXED text+tool_use assistant (recovers usage only)', () => {
  const rec = {
    type: 'assistant',
    sessionId: 's-id',
    uuid: 'a-uuid',
    message: {
      model: 'claude-fake-1',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x' } },
      ],
      usage: {
        input_tokens: 7,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
  expect(slimClaudeUsageRecord(rec)).toEqual({
    type: 'assistant',
    sessionId: 's-id',
    uuid: 'a-uuid',
    message: {
      model: 'claude-fake-1',
      usage: {
        input_tokens: 7,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
});

test('slimClaudeUsageRecord keeps a usage-bearing assistant with an EMPTY usage object (intentional; matches aggregateUsage)', () => {
  expect(
    slimClaudeUsageRecord({ type: 'assistant', sessionId: 's', uuid: 'u', message: { usage: {} } }),
  ).toEqual({ type: 'assistant', sessionId: 's', uuid: 'u', message: { usage: {} } });
});

test('recovers a MIXED text+tool_use assistant record (slims it; reasoning text AND tool content both stripped)', async () => {
  const user =
    '{"type":"user","promptId":"p1","message":{"role":"user","content":"hi"},"uuid":"u1","sessionId":"s1","version":"2.1.122"}';
  const mixed =
    '{"type":"assistant","message":{"model":"claude-fake-1","role":"assistant","content":[{"type":"text","text":"REASONING-TEXT-XYZ"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/SECRET-PATH"}}],"usage":{"input_tokens":7,"output_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"u2","sessionId":"s1"}';
  const finalText =
    '{"type":"assistant","message":{"model":"claude-fake-1","role":"assistant","content":[{"type":"text","text":"all done"}],"usage":{"input_tokens":2,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":45000}},"uuid":"u3","sessionId":"s1"}';
  const content = [user, mixed, finalText].join('\n') + '\n';
  const file = await makeFile(content);
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  const body = DECODER.decode(zstdDecompressSync(batch.body));
  // a mixed record is dropped by isDialogueRecord (via hasToolUse) → recovered as slim; usage present
  expect(body).toContain('"input_tokens":7');
  // BOTH the reasoning text and the tool content are stripped (mixed records are slimmed, not shown)
  expect(body).not.toContain('REASONING-TEXT-XYZ');
  expect(body).not.toContain('SECRET-PATH');
  // final dialogue retained verbatim
  expect(body).toContain('all done');
});
