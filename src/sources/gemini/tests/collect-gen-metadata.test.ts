import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import { requireDefined, sha256Hex, zstdDecompressSync } from 'core/utils';
import { getCursor, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import { collectGeminiGenMetadata } from 'sources/gemini';
import type { DiscoveredGeminiDbFile, GeminiCollectorContext } from 'sources/gemini';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-tokens-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

const DECODER = new TextDecoder();
const TRANSCRIPT =
  '/Users/t/.gemini/antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl';

/** gen_metadata fixture with EXTRA columns (`size`, `notes`) to prove the allow-list. */
async function makeGenMetadataDb(
  rows: { idx: number; data: Uint8Array; notes: string }[],
): Promise<DiscoveredGeminiDbFile> {
  const dbPath = join(dir, 'conv-1.db');
  const db = new Database(dbPath, { create: true });
  db.run(
    `CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER, notes TEXT)`,
  );
  for (const r of rows) {
    db.query('INSERT INTO gen_metadata (idx, data, size, notes) VALUES (?, ?, ?, ?)').run(
      r.idx,
      r.data,
      r.data.byteLength,
      r.notes,
    );
  }
  db.close();
  const stat = await statFile(dbPath);
  if (!stat.exists) throw new Error('fixture db missing after write');
  return {
    dbPath,
    transcriptSourcePath: TRANSCRIPT,
    transcriptSourcePathHash: sha256Hex(TRANSCRIPT),
    conversationId: 'conv-1',
    dbSizeBytes: stat.size,
    dbInode: Number(stat.inode),
    sourcePlatform: 'antigravity-ide',
  };
}

function ctx(overrides: Partial<GeminiCollectorContext> = {}): GeminiCollectorContext {
  return {
    buffer,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
    ...overrides,
  };
}

function decodeBatchRows(body: Uint8Array): Array<Record<string, unknown>> {
  return JSON.parse(DECODER.decode(zstdDecompressSync(body))) as Array<Record<string, unknown>>;
}

test('captures gen_metadata as base64 sqlite_rows_json stamped with the transcript path', async () => {
  const b0 = new Uint8Array([0x0a, 0x03, 1, 2, 3]);
  const b1 = new Uint8Array([0xff, 0x00, 0x7f]);
  const file = await makeGenMetadataDb([
    { idx: 0, data: b0, notes: 'n0' },
    { idx: 1, data: b1, notes: 'n1' },
  ]);

  const result = await collectGeminiGenMetadata(file, ctx());
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);

  const batch = requireDefined(nextPendingBatch(buffer), 'batch');
  expect(batch.bodyFormat).toBe('sqlite_rows_json');
  expect(batch.bodyCompression).toBe('zstd');
  expect(batch.watermarkTable).toBe('gen_metadata');
  expect(batch.watermarkKind).toBe('rowid_range');
  expect(batch.sourcePath).toBe(TRANSCRIPT);
  expect(batch.sourcePathHash).toBe(sha256Hex(TRANSCRIPT));
  expect(batch.sourceInode).toBeNull();
  expect(batch.agentSchemaVersion).toBe('antigravity/3.0.0');

  // Round-trip: base64 `data` decodes back to the exact original bytes.
  const decoded = decodeBatchRows(batch.body);
  expect(decoded.map((r) => r.idx)).toEqual([0, 1]);
  const row0 = requireDefined(decoded[0], 'row0');
  const row1 = requireDefined(decoded[1], 'row1');
  expect([...Buffer.from(row0.data as string, 'base64')]).toEqual([...b0]);
  expect([...Buffer.from(row1.data as string, 'base64')]).toEqual([...b1]);

  // Cursor advanced past the last rowid.
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: sha256Hex(TRANSCRIPT),
    sourceInode: null,
    watermarkTable: 'gen_metadata',
  });
  expect(cursor?.watermarkEnd).toBe(2); // last idx (1) + 1
});

test('ships ONLY {idx, data} columns — no content column leaks (allow-list)', async () => {
  const file = await makeGenMetadataDb([
    { idx: 0, data: new Uint8Array([1, 2, 3]), notes: 'SECRET_CONTENT_should_never_ship' },
  ]);

  await collectGeminiGenMetadata(file, ctx());
  const batch = requireDefined(nextPendingBatch(buffer), 'batch');
  const raw = DECODER.decode(zstdDecompressSync(batch.body));

  expect(raw).not.toContain('SECRET_CONTENT');
  expect(raw).not.toContain('notes');
  expect(raw).not.toContain('size');
  for (const row of decodeBatchRows(batch.body)) {
    expect(Object.keys(row).toSorted()).toEqual(['data', 'idx']);
  }
});

test('excluded conversation → 0 batches, cursor frozen (PAUSE)', async () => {
  const file = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([1]), notes: 'n' }]);

  const result = await collectGeminiGenMetadata(
    file,
    ctx({
      excludedProjects: ['/Users/t/work/secret-proj'],
      agyhubFolders: new Map([['conv-1', ['/Users/t/work/secret-proj']]]),
      agyhubComplete: true,
    }),
  );

  expect(result.capturedBatches).toBe(0);
  expect(nextPendingBatch(buffer)).toBeNull();
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: sha256Hex(TRANSCRIPT),
    sourceInode: null,
    watermarkTable: 'gen_metadata',
  });
  expect(cursor).toBeNull(); // no setCursor → watermark frozen → backfills if un-excluded
});

test('partial agyhub index (agyhubComplete=false) → PAUSE when exclusions active', async () => {
  const file = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([1]), notes: 'n' }]);

  const result = await collectGeminiGenMetadata(
    file,
    ctx({ excludedProjects: ['/x'], agyhubFolders: new Map(), agyhubComplete: false }),
  );

  expect(result.capturedBatches).toBe(0);
  expect(nextPendingBatch(buffer)).toBeNull();
});

test('advances the rowid watermark across ticks (no re-capture)', async () => {
  const file = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([1]), notes: 'n' }]);
  const first = await collectGeminiGenMetadata(file, ctx());
  expect(first.capturedBatches).toBe(1);

  // Second tick over the SAME db (cursor already advanced past rowid 1) → no new rows.
  const second = await collectGeminiGenMetadata(file, ctx());
  expect(second.capturedBatches).toBe(0);
});

test('error on the FIRST attempt does not drop gen#0 on recovery (error-path floor)', async () => {
  // First attempt fails (missing db → snapshotSqlite throws) → catch sets the cursor.
  const bad: DiscoveredGeminiDbFile = {
    dbPath: join(dir, 'does-not-exist.db'),
    transcriptSourcePath: TRANSCRIPT,
    transcriptSourcePathHash: sha256Hex(TRANSCRIPT),
    conversationId: 'conv-1',
    dbSizeBytes: 0,
    dbInode: 0,
    sourcePlatform: 'antigravity-ide',
  };
  const r1 = await collectGeminiGenMetadata(bad, ctx());
  expect(r1.errors.length).toBe(1);
  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: sha256Hex(TRANSCRIPT),
    sourceInode: null,
    watermarkTable: 'gen_metadata',
  });
  expect(cursor?.watermarkEnd).toBe(0); // NOT 1 — a `?? 1` here would floor at idx>0

  // Recovery over the SAME conversation with a valid db → gen#0 (idx 0) must still ship.
  const good = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([7, 8, 9]), notes: 'n' }]);
  const r2 = await collectGeminiGenMetadata(good, ctx());
  expect(r2.capturedBatches).toBe(1);
  const batch = requireDefined(nextPendingBatch(buffer), 'batch');
  expect(decodeBatchRows(batch.body).map((r) => r.idx)).toEqual([0]);
});

test('exclusions active but conversation absent from the agyhub map → captures (fail-open)', async () => {
  const file = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([1, 2, 3]), notes: 'n' }]);
  // excluded list is non-empty and the index is complete, but conv-1 is not in
  // the folder map → no folder to protect → fall through the gate and capture.
  const result = await collectGeminiGenMetadata(
    file,
    ctx({ excludedProjects: ['/x/excluded'], agyhubFolders: new Map(), agyhubComplete: true }),
  );
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);
});

test('a slice exceeding maxDecompressedBytes is recorded as an error (oversized guard)', async () => {
  const file = await makeGenMetadataDb([{ idx: 0, data: new Uint8Array([1, 2, 3]), notes: 'n' }]);
  // A 1-byte cap makes even a single tiny row's serialized JSON exceed the cap.
  const result = await collectGeminiGenMetadata(file, ctx({ maxDecompressedBytes: 1 }));
  expect(result.capturedBatches).toBe(0);
  expect(nextPendingBatch(buffer)).toBeNull();
  expect(result.errors.length).toBeGreaterThan(0);
});
