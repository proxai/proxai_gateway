import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import {
  countByStatus,
  getCursor,
  nextPendingBatch,
  openInMemoryBufferDb,
  totalPendingBytes,
} from 'services/buffer';
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
  return { buffer: b, gatewayVersion: '@proxai/gateway 0.1.0' };
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
