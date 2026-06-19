import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
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

// A real-shaped Antigravity transcript line: USER_EXPLICIT / MODEL / SYSTEM sources with
// USER_INPUT / PLANNER_RESPONSE / CONVERSATION_HISTORY types. NONE is user/assistant — the
// claude-code isDialogueRecord filter would drop every one of these. Real transcripts use the
// "source" key (not "origin"); capture is key-agnostic, so the fixtures mirror reality.
const TRANSCRIPT_LINES = [
  '{"source":"USER_EXPLICIT","type":"USER_INPUT","text":"fix the search bug"}',
  '{"source":"MODEL","type":"PLANNER_RESPONSE","text":"Looking into it now."}',
  '{"source":"SYSTEM","type":"CONVERSATION_HISTORY","summary":"prior turns"}',
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

test('captures a model/system-only transcript (no USER_INPUT)', async () => {
  // Pins the "no user-presence gate": a transcript with zero USER_* lines still captures.
  const file = await makeTranscript([
    JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      step_index: 0,
      content: 'Looking into it.',
    }),
    JSON.stringify({
      source: 'SYSTEM',
      type: 'CONVERSATION_HISTORY',
      status: 'DONE',
      step_index: 1,
      content: null,
    }),
  ]);
  const result = await collectGeminiConversation(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);
});

test('capturedBytes equals the summed compressed batch body sizes', async () => {
  const file = await makeTranscript(TRANSCRIPT_LINES);
  const result = await collectGeminiConversation(file, ctx(buffer));

  expect(result.capturedBatches).toBe(1);
  expect(result.capturedBytes).toBeGreaterThan(0);

  const summedBodyBytes = readBatches(buffer).reduce((sum, b) => sum + b.body.byteLength, 0);
  expect(result.capturedBytes).toBe(summedBodyBytes);
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
  const file = await makeTranscript([completeLine, '{"source":"MODEL","type":"PLANNER_'], {
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

test('FAIL CLOSED: agyhubComplete:false + active exclusions captures nothing and writes no cursor', async () => {
  // A truncated/mid-write agyhub index means an excluded conversation may simply be absent from
  // the partial map. The gate must pause even for a uuid that is not in the map at all.
  const file = await makeTranscript(TRANSCRIPT_LINES, { conversationId: 'cascade-not-in-map' });
  const agyhubFolders = new Map<string, string[]>([['cascade-other', ['/Users/me/whatever']]]);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, {
      excludedProjects: ['/Users/me/secret'],
      agyhubFolders,
      agyhubComplete: false,
    }),
  );

  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  expect(readBatches(buffer).length).toBe(0);
  // Fail-closed PAUSE: no cursor row written, so it backfills next cycle once the index is whole.
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

test('splits an oversized transcript into contiguous byte_range batches covering every line', async () => {
  // Many fat lines + a small decompressed cap forces splitJsonlAtBoundary to chunk. Mirrors the
  // claude-code contiguity test: batches must tile [0, size) with no gap or overlap.
  const total = 20;
  const markers: string[] = [];
  const linesArr: string[] = [];
  for (let i = 0; i < total; i++) {
    const marker = `gemini-line-marker-${i}`;
    markers.push(marker);
    linesArr.push(
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        marker,
        noise: randomBytes(1000).toString('base64'),
      }),
    );
  }
  const file = await makeTranscript(linesArr);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { maxDecompressedBytes: 15_000 }),
  );
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  const batches = readBatches(buffer);
  expect(batches.length).toBe(result.capturedBatches);

  let prevEnd = 0;
  let allBodies = '';
  for (const batch of batches) {
    expect(batch.watermark_start).toBe(prevEnd);
    expect(batch.watermark_end).toBeGreaterThan(batch.watermark_start);
    prevEnd = batch.watermark_end;
    allBodies += DECODER.decode(zstdDecompressSync(batch.body));
  }
  const first = batches[0];
  if (first === undefined) throw new Error('no batches');
  expect(first.watermark_start).toBe(0);
  expect(prevEnd).toBe(file.sizeBytes);
  expect(cursorRow(file)?.watermarkEnd).toBe(file.sizeBytes);

  // Every kept line is present exactly once across the batch bodies.
  for (const marker of markers) {
    expect(allBodies).toContain(marker);
  }
});

test('multi-slice with interleaved unparseable lines: kept-vs-raw byte mapping stays contiguous', async () => {
  // Locks the F5 raw-byte offset behaviour: unparseable lines are dropped from the body but their
  // bytes still belong to the scanned range, so the final batch end + cursor still reach size, and
  // batch boundaries remain contiguous. An invalid-UTF8 line is included to exercise the raw split.
  const markers: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < 20; i++) {
    const marker = `keep-marker-${i}`;
    markers.push(marker);
    parts.push(
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        marker,
        noise: randomBytes(1000).toString('base64'),
      }),
    );
    // Interleave junk: a non-JSON line dropped by the parse-guard but still inside the byte range.
    if (i % 3 === 0) parts.push('this is not json at all');
  }
  // Build the file with a raw invalid-UTF8 byte (0xff) embedded on its own line.
  const path = join(dir, 'transcript.jsonl');
  const head = Buffer.from(parts.join('\n') + '\n', 'utf8');
  const junkLine = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('\n', 'utf8')]);
  const tailMarker = 'keep-marker-tail';
  markers.push(tailMarker);
  const tail = Buffer.from(
    JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', marker: tailMarker }) + '\n',
    'utf8',
  );
  await writeFile(path, Buffer.concat([head, junkLine, tail]));
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  const file: DiscoveredGeminiFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    sourcePlatform: 'antigravity-cli',
    conversationId: 'cascade-junk',
  };

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { maxDecompressedBytes: 15_000 }),
  );
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  const batches = readBatches(buffer);
  let prevEnd = 0;
  let allBodies = '';
  for (const batch of batches) {
    expect(batch.watermark_start).toBe(prevEnd);
    prevEnd = batch.watermark_end;
    allBodies += DECODER.decode(zstdDecompressSync(batch.body));
  }
  // Final boundary + cursor reach the full file size even though junk lines were dropped.
  expect(prevEnd).toBe(file.sizeBytes);
  expect(cursorRow(file)?.watermarkEnd).toBe(file.sizeBytes);
  // Every parseable line survived; the junk text did not.
  for (const marker of markers) {
    expect(allBodies).toContain(marker);
  }
  expect(allBodies).not.toContain('this is not json at all');
});

test('oversized single line surfaces a decompressed-slice error and does NOT advance the cursor', async () => {
  // Mirrors the claude-code oversized test: one line bigger than maxDecompressedBytes cannot be
  // split, so the collector throws OversizedDecompressedSliceError and the cursor stays frozen.
  const giant = 'x'.repeat(20_000);
  const file = await makeTranscript([
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', text: giant }),
  ]);

  const result = await collectGeminiConversation(
    file,
    ctx(buffer, { maxDecompressedBytes: 15_000 }),
  );
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  const firstError = result.errors[0];
  if (firstError === undefined) throw new Error('expected an error');
  expect(firstError.reason).toMatch(/decompressed slice/);

  expect(readBatches(buffer).length).toBe(0);
  // The error path writes a cursor row with consecutiveErrors but watermarkEnd stays at 0 (no advance).
  expect(cursorRow(file)?.watermarkEnd ?? 0).toBe(0);
});
