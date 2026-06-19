import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import { getCursor, openInMemoryBufferDb } from 'services/buffer';
import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import { collectGeminiConversation } from 'sources/gemini';
import type { DiscoveredGeminiFile, GeminiCollectorContext } from 'sources/gemini';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-collect-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

function ctx(
  b: SqliteDatabase,
  extra: Partial<GeminiCollectorContext> = {},
): GeminiCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
    ...extra,
  };
}

// A real-shaped Antigravity transcript line: USER_EXPLICIT / MODEL / SYSTEM origins with
// USER_INPUT / PLANNER_RESPONSE / CONVERSATION_HISTORY types. NONE is user/assistant — the
// claude-code isDialogueRecord filter would drop every one of these.
const TRANSCRIPT_LINES = [
  '{"origin":"USER_EXPLICIT","type":"USER_INPUT","text":"fix the search bug"}',
  '{"origin":"MODEL","type":"PLANNER_RESPONSE","text":"Looking into it now."}',
  '{"origin":"SYSTEM","type":"CONVERSATION_HISTORY","summary":"prior turns"}',
];

async function makeTranscript(
  lines: string[],
  options: { trailingNewline?: boolean; conversationId?: string } = {},
): Promise<DiscoveredGeminiFile> {
  const path = join(dir, 'transcript.jsonl');
  const trailingNewline = options.trailingNewline ?? true;
  const content = lines.join('\n') + (trailingNewline ? '\n' : '');
  await writeFile(path, content);
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    sourcePlatform: 'antigravity-cli',
    conversationId: options.conversationId ?? 'cascade-1',
  };
}

interface BatchRow {
  watermark_table: string | null;
  watermark_kind: string;
  watermark_start: number;
  watermark_end: number;
  source_app: string;
  source_platform: string | null;
  source_kind: string;
  agent_schema_version: string;
  body_format: string;
  body: Uint8Array;
}

function readBatches(b: SqliteDatabase): BatchRow[] {
  return b
    .query<
      BatchRow,
      []
    >('SELECT watermark_table, watermark_kind, watermark_start, watermark_end, source_app, source_platform, source_kind, agent_schema_version, body_format, body FROM upload_batches ORDER BY watermark_start ASC')
    .all();
}

function cursorRow(file: DiscoveredGeminiFile): ReturnType<typeof getCursor> {
  return getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
}

test('captures every complete line with no content filter (one jsonl/byte_range batch)', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES);
  const result = await collectGeminiConversation(file, ctx(buffer));

  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);

  const batches = readBatches(buffer);
  expect(batches.length).toBe(1);
  const batch = batches[0];
  if (batch === undefined) throw new Error('missing batch');

  expect(batch.source_app).toBe('gemini');
  expect(batch.source_platform).toBe('antigravity-cli');
  expect(batch.source_kind).toBe('jsonl_append');
  expect(batch.body_format).toBe('jsonl');
  expect(batch.watermark_kind).toBe('byte_range');
  expect(batch.agent_schema_version).toBe('antigravity/2.0.0');
  expect(batch.watermark_start).toBe(0);

  // watermarkEnd covers exactly the complete-line bytes (the whole file, since it ends in \n).
  const completeBytes = ENCODER.encode(TRANSCRIPT_LINES.join('\n') + '\n').byteLength;
  expect(batch.watermark_end).toBe(completeBytes);

  // No content filter: every line survives in the captured (redacted) body.
  const bodyText = DECODER.decode(zstdDecompressSync(batch.body));
  expect(bodyText).toContain('USER_INPUT');
  expect(bodyText).toContain('PLANNER_RESPONSE');
  expect(bodyText).toContain('CONVERSATION_HISTORY');

  expect(cursorRow(file)?.watermarkEnd).toBe(completeBytes);
});

test('does nothing on a second poll with no new bytes', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES);
  await collectGeminiConversation(file, ctx(buffer));

  const second = await collectGeminiConversation(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(second.errors).toEqual([]);
  expect(readBatches(buffer).length).toBe(1);
});

test('holds back a trailing partial line; watermarkEnd is the last complete-line boundary', async () => {
  const completeLine = TRANSCRIPT_LINES[0];
  if (completeLine === undefined) throw new Error('fixture line missing');
  // File ends WITHOUT a trailing newline: the second line is incomplete and must be held back.
  const file = await makeTranscript([completeLine, '{"origin":"MODEL","type":"PLANNER_'], {
    trailingNewline: false,
  });

  const result = await collectGeminiConversation(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);

  const batch = readBatches(buffer)[0];
  if (batch === undefined) throw new Error('missing batch');

  const completeBytes = ENCODER.encode(completeLine + '\n').byteLength;
  expect(batch.watermark_end).toBe(completeBytes);

  const bodyText = DECODER.decode(zstdDecompressSync(batch.body));
  expect(bodyText).toContain('USER_INPUT');
  expect(bodyText).not.toContain('PLANNER_'); // partial line excluded

  expect(cursorRow(file)?.watermarkEnd).toBe(completeBytes);
});

test('PAUSE: an excluded folder for this conversation captures nothing and writes no cursor', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES, { conversationId: 'cascade-secret' });
  const agyhubFolders = new Map<string, string[]>([
    ['cascade-secret', ['/Users/me/ok', '/Users/me/secret']],
  ]);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { excludedProjects: ['/Users/me/secret'], agyhubFolders }),
  );

  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  expect(readBatches(buffer).length).toBe(0);
  // PAUSE means the byte watermark stays frozen: no cursor row written at all.
  expect(cursorRow(file)).toBeNull();
});

test('fail-open: unknown conversation folder under a non-empty exclusion list still captures', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES, { conversationId: 'cascade-unknown' });
  // conversationId absent from the folder map -> no folder identity -> fail open (capture).
  const agyhubFolders = new Map<string, string[]>([['cascade-other', ['/Users/me/secret']]]);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { excludedProjects: ['/Users/me/secret'], agyhubFolders }),
  );

  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
  expect(readBatches(buffer).length).toBe(1);
});

test('fail-open: empty folder list for the conversation still captures', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES, { conversationId: 'cascade-empty' });
  const agyhubFolders = new Map<string, string[]>([['cascade-empty', []]]);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { excludedProjects: ['/Users/me/secret'], agyhubFolders }),
  );

  expect(result.capturedBatches).toBe(1);
  expect(readBatches(buffer).length).toBe(1);
});
