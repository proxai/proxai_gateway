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
import { collectCodexRollout, trimCodexRecord } from 'sources/codex';
import type { CodexCollectorContext, DiscoveredCodexRolloutFile } from 'sources/codex';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-codex-rollout-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

async function makeFile(
  content: string,
  name = 'rollout.jsonl',
): Promise<DiscoveredCodexRolloutFile> {
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

function ctx(b: Database): CodexCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

const nullCliVersionReader = async (): Promise<string | null> => null;

const DECODER = new TextDecoder();

function codexRecordKind(line: string): string {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object') {
    return '';
  }
  const rec = parsed as { type?: unknown; payload?: { type?: unknown; role?: unknown } };
  if (rec.type === 'event_msg' || rec.type === 'response_item') {
    const payload = rec.payload ?? {};
    const role = typeof payload.role === 'string' ? `:${payload.role}` : '';
    return `${String(rec.type)}:${String(payload.type)}${role}`;
  }
  return String(rec.type);
}

test('inserts a batch covering newly added complete lines', async () => {
  const file = await makeFile(
    '{"timestamp":"2026-04-29T10:00:00Z","type":"session_meta","payload":{}}\n',
  );
  const result = await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(1);
  expect(totalPendingBytes(buffer)).toBeGreaterThan(0);
});

test('advances cursor to the safe end byte', async () => {
  const content =
    '{"type":"session_meta","payload":{"a":1}}\n{"type":"session_meta","payload":{"b":2}}\n';
  const file = await makeFile(content);
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});

test('does nothing on a second poll with no new bytes', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"a":1}}\n');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const second = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('holds back trailing partial line and only advances to last newline', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"a":1}}\n{"b":');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe('{"type":"session_meta","payload":{"a":1}}\n'.length);
});

test('does not insert a batch when no complete line is present', async () => {
  const file = await makeFile('{"a":');
  const result = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('per-rollout cli_version from session_meta overrides the caller-provided default', async () => {
  const file = await makeFile(
    '{"type":"session_meta","payload":{"cli_version":"0.200.0-rc.1"}}\n{"type":"session_meta","payload":{"entry":2}}\n',
  );
  await collectCodexRollout(file, ctx(buffer), 'caller-default');
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('0.200.0-rc.1');
});

test('falls back to caller-provided default when reader returns null', async () => {
  const file = await makeFile(
    '{"type":"session_meta","payload":{"data":1}}\n{"type":"session_meta","payload":{"entry":2}}\n',
  );
  const fakeCtx: CodexCollectorContext = {
    ...ctx(buffer),
    rolloutVersionReader: nullCliVersionReader,
  };
  await collectCodexRollout(file, fakeCtx, 'caller-default');
  const batch = nextPendingBatch(buffer);
  expect(batch?.agentSchemaVersion).toBe('caller-default');
});

test('uses the provided agent_schema_version verbatim', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"a":1}}\n');
  await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.agentSchemaVersion).toBe('0.126.0-alpha.8');
});

test('redacts secrets from the body before storing', async () => {
  const file = await makeFile(
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'export OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
          },
        ],
      },
    }) + '\n',
  );
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = requireDefined(nextPendingBatch(buffer));
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('records errors and does not advance cursor when the file is unreadable', async () => {
  const fakeFile: DiscoveredCodexRolloutFile = {
    sourcePath: join(dir, 'does-not-exist.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.jsonl')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const result = await collectCodexRollout(fakeFile, ctx(buffer), '0.1.0');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('increments consecutive_errors on per-file collector failure', async () => {
  const fakeFile: DiscoveredCodexRolloutFile = {
    sourcePath: join(dir, 'does-not-exist-2.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist-2.jsonl')),
    inode: 7777,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: fakeFile.sourcePathHash,
    sourcePath: fakeFile.sourcePath,
    sourceInode: fakeFile.inode,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 1,
  });
  await collectCodexRollout(fakeFile, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: fakeFile.sourcePathHash,
    sourceInode: fakeFile.inode,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(2);
});

test('resets consecutive_errors on success after prior failure', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"a":1}}\n');
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: file.inode,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 7,
  });
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"a":1}}\n');
  await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourceApp).toBe('codex');
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
    linesArr.push(JSON.stringify({ type: 'session_meta', payload: { i, noise } }));
  }
  const content = `${linesArr.join('\n')}\n`;
  const file = await makeFile(content, 'big.jsonl');

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const result = await collectCodexRollout(file, customCtx, '0.126.0');
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
    sourceApp: 'codex',
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
    lines.push(JSON.stringify({ type: 'session_meta', payload: { i, key: longSecret } }));
  }
  const content = `${lines.join('\n')}\n`;
  const file = await makeFile(content, 'redaction.jsonl');

  const result = await collectCodexRollout(file, ctx(buffer), '0.126.0');
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
    sourceApp: 'codex',
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
  const oneLine = `${JSON.stringify({ type: 'session_meta', payload: { giant: giantPayload } })}\n`;
  const file = await makeFile(oneLine, 'oversized.jsonl');

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const result = await collectCodexRollout(file, customCtx, '0.1.0');
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  expect(requireDefined(result.errors[0]).reason).toMatch(/decompressed slice/);
}, 30_000);

test('every batch satisfies BOTH compressed AND decompressed caps', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({ type: 'session_meta', payload: { i, payload: 'x'.repeat(40) } }));
  }
  const content = `${lines.join('\n')}\n`;
  const file = await makeFile(content, 'invariant.jsonl');

  const result = await collectCodexRollout(file, ctx(buffer), '0.1.0');
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
  const file = { ...(await makeFile('{"type":"session_meta","payload":{"a":1}}\n')), inode: 1001 };
  const first = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(first.capturedBatches).toBe(1);

  const newContent = '{"type":"session_meta","payload":{"b":2}}\n';
  await writeFile(file.sourcePath, newContent);
  const rotated = { ...file, inode: 1002, sizeBytes: newContent.length };

  const second = await collectCodexRollout(rotated, ctx(buffer), '0.1.0');
  expect(second.capturedBatches).toBe(1);
  expect(countByStatus(buffer).pending).toBe(2);

  const cursorOld = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  const cursorNew = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: rotated.inode,
    watermarkTable: null,
  });
  expect(cursorOld?.watermarkEnd).toBe('{"type":"session_meta","payload":{"a":1}}\n'.length);
  expect(cursorNew?.watermarkEnd).toBe(newContent.length);
});

test('dialogue telemetry filtering, pruning, and discards', async () => {
  const content =
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cli_version: '0.1.0',
          base_instructions: { text: 'secret instructions' },
          dynamic_tools: [{ name: 'git' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total: 9 } } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'mcp_tool_call_end' } }),
      JSON.stringify({ type: 'event_msg' }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'sys' }],
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      JSON.stringify({ type: 'turn_context', payload: { cwd: '/repo' } }),
      '42',
    ].join('\n') + '\n';

  const file = await makeFile(content);
  const result = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);

  const batch = requireDefined(nextPendingBatch(buffer));
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  const keptKinds = decompressed.trim().split('\n').map(codexRecordKind);
  expect(keptKinds).toEqual([
    'session_meta',
    'event_msg:task_started',
    'response_item:message:user',
    'event_msg:token_count',
    'response_item:message:assistant',
    'event_msg:task_complete',
  ]);

  expect(decompressed).toContain('"base_instructions":"<trimmed>"');
  expect(decompressed).not.toContain('secret instructions');
  expect(decompressed).toContain('"dynamic_tools":[]');
});

test('trimCodexRecord returns non-object inputs verbatim', () => {
  expect(trimCodexRecord(null)).toBeNull();
  expect(trimCodexRecord(undefined)).toBeUndefined();
  expect(trimCodexRecord(123)).toBe(123);
  expect(trimCodexRecord('string')).toBe('string');
});

test('advances cursor and returns zero batches when no dialogue records are found', async () => {
  const file = await makeFile('{"type":"other"}\n');
  const result = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBeGreaterThan(0);
});

test('tags codex-cli when session_meta source is cli', async () => {
  const file = await makeFile(
    '{"type":"session_meta","payload":{"source":"cli","originator":"codex-tui"}}\n',
  );
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourceApp).toBe('codex');
  expect(batch.sourcePlatform).toBe('codex-cli');
});

test('tags codex-desktop when session_meta source is vscode', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"source":"vscode"}}\n');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('codex-desktop');
});

test('tags codex-desktop when session_meta originator is Codex Desktop', async () => {
  const file = await makeFile('{"type":"session_meta","payload":{"originator":"Codex Desktop"}}\n');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('codex-desktop');
});

test('falls back to codex-cli when no session_meta platform signal is present', async () => {
  const file = await makeFile(
    '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n',
  );
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePlatform).toBe('codex-cli');
});

test('pauses an excluded codex rollout: nothing captured, watermark unchanged', async () => {
  const content =
    '{"type":"session_meta","cwd":"/Users/me/secret"}\n' +
    '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n';
  const file = await makeFile(content);
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];

  const result = await collectCodexRollout(file, c, 'codex/test');

  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd ?? 0).toBe(0);
});

test('captures a non-excluded codex rollout normally', async () => {
  const content =
    '{"type":"session_meta","cwd":"/Users/me/keep"}\n' +
    '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n';
  const file = await makeFile(content);
  const c = ctx(buffer);
  c.excludedProjects = ['/Users/me/secret'];
  const result = await collectCodexRollout(file, c, 'codex/test');
  expect(result.capturedBatches).toBeGreaterThan(0);
});

test('backfills a codex rollout when removed from the exclusion list', async () => {
  const content =
    '{"type":"session_meta","cwd":"/Users/me/secret"}\n' +
    '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n';
  const file = await makeFile(content);

  const exCtx = ctx(buffer);
  exCtx.excludedProjects = ['/Users/me/secret'];
  await collectCodexRollout(file, exCtx, 'codex/test');
  expect(countByStatus(buffer).pending).toBe(0);

  const openCtx = ctx(buffer);
  openCtx.excludedProjects = [];
  const result = await collectCodexRollout(file, openCtx, 'codex/test');
  expect(result.capturedBatches).toBeGreaterThan(0);
});
