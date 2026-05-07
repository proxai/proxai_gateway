import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { nextGenerationSuffix, sha256Hex, zstdDecompressSync } from 'core/utils';
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
import { collectCursorFile } from 'sources/cursor';
import type { CursorCollectorContext, DiscoveredCursorFile } from 'sources/cursor';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-cursor-collect-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

interface SeedRow {
  key: string;
  value: string;
}

async function makeDb(rows: SeedRow[], name = 'state.vscdb'): Promise<DiscoveredCursorFile> {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  for (const row of rows) {
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(row.key, row.value);
  }
  db.close();
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

async function makeEmptyFile(name = 'empty.vscdb'): Promise<DiscoveredCursorFile> {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE somethingElse (id INTEGER PRIMARY KEY)');
  db.close();
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

function ctx(b: SqliteDatabase): CursorCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

const DECODER = new TextDecoder();

test('inserts a batch covering filtered composer and bubble rows', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13,"name":"x"}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3,"type":1,"text":"hello"}' },
  ]);
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(1);
  expect(totalPendingBytes(buffer)).toBeGreaterThan(0);
});

test('skip-listed keys are filtered out of the body', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'agentKv:blob:abc', value: '{"junk":true}' },
    { key: 'checkpointId:42', value: '{}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3,"type":1}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  const text = DECODER.decode(zstdDecompressSync(batch.body));
  expect(text).toContain('composerData:c1');
  expect(text).toContain('bubbleId:c1:b1');
  expect(text).not.toContain('agentKv:blob');
  expect(text).not.toContain('checkpointId');
});

test('does nothing when only skip-listed rows exist', async () => {
  const file = await makeDb([
    { key: 'agentKv:blob:abc', value: '{}' },
    { key: 'checkpointId:42', value: '{}' },
  ]);
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('does nothing when the cursorDiskKV table is missing', async () => {
  const file = await makeEmptyFile();
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('persists the rowid range watermark with end = last_rowid + 1', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
    { key: 'bubbleId:c1:b2', value: '{"_v":3}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.watermarkKind).toBe('rowid_range');
  expect(batch.watermarkStart).toBe(1);
  expect(batch.watermarkEnd).toBe(4);
  const cursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(4);
});

test('does nothing on a second poll with no new rows', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const second = await collectCursorFile(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('only ships rows past the saved watermark on subsequent polls', async () => {
  const path = join(dir, 'incremental.vscdb');
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:c1',
    '{"_v":13}',
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:c1:b1', '{"_v":3}');
  db.close();
  let stat = await statFile(path);
  if (!stat.exists) throw new Error('missing');
  const file: DiscoveredCursorFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  await collectCursorFile(file, ctx(buffer));

  const db2 = new Database(path);
  db2
    .query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    .run('bubbleId:c1:b2', '{"_v":3}');
  db2.close();
  stat = await statFile(path);
  if (!stat.exists) throw new Error('missing');
  const file2: DiscoveredCursorFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const second = await collectCursorFile(file2, ctx(buffer));
  expect(second.capturedBatches).toBe(1);
  const batches = countByStatus(buffer);
  expect(batches.pending).toBe(2);
  const newest = nextPendingBatch(buffer);
  expect(newest).not.toBeNull();
});

test('extracts agent_schema_version from composer and bubble _v fields', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13,"name":"x"}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3,"type":1}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.agentSchemaVersion).toBe('13:3');
});

test('falls back to "unknown" when neither prefix yields parseable rows', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: 'not-json' },
    { key: 'bubbleId:c1:b1', value: 'also-not-json' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.agentSchemaVersion).toBe('unknown');
});

test('redacts secrets embedded in row values before storing', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    {
      key: 'bubbleId:c1:b1',
      value:
        '{"_v":3,"text":"export OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt"}',
    },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('records errors and does not advance cursor when the file is unreadable', async () => {
  const fakeFile: DiscoveredCursorFile = {
    sourcePath: join(dir, 'does-not-exist.vscdb'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.vscdb')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const result = await collectCursorFile(fakeFile, ctx(buffer));
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;
  expect(batch.sourceApp).toBe('cursor');
  expect(batch.sourceKind).toBe('sqlite_kv_snapshot');
  expect(batch.bodyFormat).toBe('kv_pairs_json');
  expect(batch.bodyCompression).toBe('zstd');
  expect(batch.watermarkKind).toBe('rowid_range');
  expect(batch.watermarkTable).toBeNull();
  expect(batch.sourceInode).toBeNull();
  expect(batch.gatewayVersion).toBe('@proxai/gateway 0.1.0');
  expect(batch.capturedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('a fresh poll persists last_seen_size_bytes and last_seen_page_count on the cursor', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
  ]);
  await collectCursorFile(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor).not.toBeNull();
  expect(cursor!.lastSeenSizeBytes).toBeGreaterThan(0);
  expect(cursor!.lastSeenPageCount).toBeGreaterThan(0);
});

test('rowid regression triggers re-keying under #gen=1 with a fresh watermark', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
  ]);
  setCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 1000,
    lastSeenSizeBytes: 99_000_000,
    lastSeenPageCount: 24_000,
  });

  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);

  const batch = nextPendingBatch(buffer)!;

  const expectedNewPath = nextGenerationSuffix(file.sourcePath);
  expect(batch.sourcePath).toBe(expectedNewPath);
  expect(batch.sourcePathHash).toBe(sha256Hex(expectedNewPath));

  expect(batch.watermarkStart).toBe(1);
  expect(batch.watermarkEnd).toBe(3);

  const newCursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: sha256Hex(expectedNewPath),
    sourceInode: null,
    watermarkTable: null,
  });
  expect(newCursor?.watermarkEnd).toBe(3);

  const oldCursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(oldCursor?.watermarkEnd).toBe(1000);
});

test('size_decreased signal also triggers re-keying via #gen suffix', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
  ]);

  setCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 2,
    lastSeenSizeBytes: 99_000_000,
    lastSeenPageCount: 1,
  });

  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);
  const batch = nextPendingBatch(buffer)!;
  expect(batch.sourcePath).toBe(nextGenerationSuffix(file.sourcePath));
  expect(batch.watermarkStart).toBe(1);
});

test('splits an oversized snapshot into multiple batches with contiguous rowid coverage', async () => {
  const rows: { key: string; value: string }[] = [];
  const rowCount = 1500;
  for (let i = 0; i < rowCount; i++) {
    const noise = randomBytes(2200).toString('base64');
    rows.push({
      key: i % 2 === 0 ? `composerData:c${i.toString()}` : `bubbleId:c${i.toString()}:b1`,
      value: JSON.stringify({ _v: 1, noise }),
    });
  }
  const file = await makeDb(rows, 'big.vscdb');

  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  let prevEnd = 0;
  let scanned = 0;
  for (let i = 0; i < 50; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_TARGET_COMPRESSED_BYTES);
    if (scanned === 0) {
      expect(batch.watermarkStart).toBe(1);
    } else {
      expect(batch.watermarkStart).toBe(prevEnd);
    }
    expect(batch.watermarkEnd).toBeGreaterThan(batch.watermarkStart);
    prevEnd = batch.watermarkEnd;
    scanned += 1;
    deleteBatch(buffer, batch.captureId);
  }
  expect(scanned).toBe(result.capturedBatches);
  const cursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });

  expect(cursor?.watermarkEnd).toBe(rowCount + 1);
  expect(prevEnd).toBe(rowCount + 1);
}, 60_000);

test('null last_seen columns on existing cursor never trigger size/page_count signals', async () => {
  const file = await makeDb([
    { key: 'composerData:c1', value: '{"_v":13}' },
    { key: 'bubbleId:c1:b1', value: '{"_v":3}' },
    { key: 'bubbleId:c1:b2', value: '{"_v":3}' },
  ]);
  setCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 1,
    lastSeenSizeBytes: null,
    lastSeenPageCount: null,
  });

  await collectCursorFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer)!;

  expect(batch.sourcePath).toBe(file.sourcePath);
  expect(batch.sourcePathHash).toBe(file.sourcePathHash);
});

test('surfaces OversizedDecompressedSliceError when single row exceeds BODY_MAX_DECOMPRESSED_BYTES', async () => {
  const giantPayload = 'x'.repeat(BODY_MAX_DECOMPRESSED_BYTES + 1024);
  const file = await makeDb([{ key: 'composerData:huge', value: giantPayload }]);

  const result = await collectCursorFile(file, ctx(buffer));
  const oversized = result.errors.filter((e) => /decompressed slice/.test(e.reason));
  expect(oversized.length).toBeGreaterThanOrEqual(1);
}, 60_000);

test('every cursor batch satisfies BOTH compressed AND decompressed caps', async () => {
  const rows: SeedRow[] = [];
  for (let i = 0; i < 80; i++) {
    rows.push({ key: `composerData:c${i.toString()}`, value: JSON.stringify({ _v: 13, k: i }) });
    rows.push({
      key: `bubbleId:c${i.toString()}:b1`,
      value: JSON.stringify({ _v: 3, txt: 'x'.repeat(60) }),
    });
  }
  const file = await makeDb(rows, 'invariant.vscdb');
  const result = await collectCursorFile(file, ctx(buffer));
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
