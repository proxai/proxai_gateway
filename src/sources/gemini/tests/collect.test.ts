import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import { getCursor, openInMemoryBufferDb } from 'services/buffer';
import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import { collectGeminiConversation } from 'sources/gemini';
import type { DiscoveredGeminiFile, GeminiCollectorContext } from 'sources/gemini';
import { concatBytes, msgField, strField, varintField } from 'sources/gemini/tests/proto-encode.ts';

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

function ctx(b: SqliteDatabase): GeminiCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

function timestamp(seconds: number): Uint8Array {
  return msgField(1, [varintField(1, seconds), varintField(2, 0)]);
}

function stepRef(cascadeId: string, idx: number): Uint8Array {
  return msgField(20, [strField(1, 'traj-1'), varintField(2, idx), strField(4, cascadeId)]);
}

function userPayload(text: string): Uint8Array {
  return concatBytes([
    varintField(1, 14),
    msgField(5, [timestamp(1781035381), varintField(3, 4), stepRef('cascade-1', 0)]),
    msgField(19, [strField(2, text)]),
  ]);
}

function toolPayload(): Uint8Array {
  return concatBytes([
    varintField(1, 21),
    msgField(5, [
      timestamp(1781035382),
      varintField(3, 2),
      msgField(4, [strField(2, 'run_command'), strField(3, '{"CommandLine":"ls"}')]),
      stepRef('cascade-1', 1),
    ]),
  ]);
}

function assistantPayload(text: string): Uint8Array {
  return concatBytes([
    varintField(1, 23),
    msgField(5, [timestamp(1781035383), varintField(3, 5), stepRef('cascade-1', 2)]),
    msgField(30, [strField(4, text)]),
  ]);
}

function metadataBlob(): Uint8Array {
  return msgField(1, [
    strField(1, 'file:///Users/me/repo'),
    msgField(3, [strField(1, 'org/repo'), strField(2, 'git@github.com:org/repo.git')]),
  ]);
}

interface MakeDbOptions {
  userText?: string;
  assistantText?: string;
}

async function makeGeminiDb(options: MakeDbOptions = {}): Promise<DiscoveredGeminiFile> {
  const path = join(dir, 'cascade-1.db');
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)',
  );
  db.run(
    'CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)',
  );
  db.run('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');

  const insertStep = db.query(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)',
  );
  insertStep.run(0, 14, 3, userPayload(options.userText ?? 'fix the search bug'));
  insertStep.run(1, 21, 3, toolPayload());
  insertStep.run(2, 23, 3, assistantPayload(options.assistantText ?? 'All done.'));

  db.query('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('traj-1', 'cascade-1', 4, 17);
  db.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', metadataBlob());
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    sourcePlatform: 'antigravity-cli',
    conversationId: '',
  };
}

interface BatchRow {
  watermark_table: string | null;
  watermark_start: number;
  watermark_end: number;
  source_platform: string | null;
  agent_schema_version: string;
  body_format: string;
  body: Uint8Array;
}

function readBatches(b: SqliteDatabase): BatchRow[] {
  return b
    .query<
      BatchRow,
      []
    >('SELECT watermark_table, watermark_start, watermark_end, source_platform, agent_schema_version, body_format, body FROM upload_batches ORDER BY watermark_table ASC')
    .all();
}

function decodeBody(batch: BatchRow): unknown {
  return JSON.parse(DECODER.decode(zstdDecompressSync(batch.body)));
}

test('captures all three tables and emits decoded plaintext step rows', async () => {
  const file = await makeGeminiDb();
  const result = await collectGeminiConversation(file, ctx(buffer));

  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(3);

  const batches = readBatches(buffer);
  const byTable = new Map(batches.map((b) => [b.watermark_table, b]));

  const stepsBatch = byTable.get('steps');
  expect(stepsBatch).toBeDefined();
  if (stepsBatch === undefined) throw new Error('missing steps batch');
  expect(stepsBatch.source_platform).toBe('antigravity-cli');
  expect(stepsBatch.agent_schema_version).toBe('antigravity/1.0.0');
  expect(stepsBatch.body_format).toBe('sqlite_rows_json');
  expect(stepsBatch.watermark_start).toBe(0);
  expect(stepsBatch.watermark_end).toBe(3);

  const stepRows = decodeBody(stepsBatch);
  expect(stepRows).toEqual([
    {
      idx: 0,
      step_type: 14,
      status: 3,
      role: 'user',
      text: 'fix the search bug',
      tool_name: null,
      tool_args_json: null,
      iso_timestamp: new Date(1781035381 * 1000).toISOString(),
      turn_id: null,
      conversation_id: 'cascade-1',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    {
      idx: 1,
      step_type: 21,
      status: 3,
      role: 'tool',
      text: null,
      tool_name: 'run_command',
      tool_args_json: '{"CommandLine":"ls"}',
      iso_timestamp: new Date(1781035382 * 1000).toISOString(),
      turn_id: null,
      conversation_id: 'cascade-1',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    {
      idx: 2,
      step_type: 23,
      status: 3,
      role: 'assistant',
      text: 'All done.',
      tool_name: null,
      tool_args_json: null,
      iso_timestamp: new Date(1781035383 * 1000).toISOString(),
      turn_id: null,
      conversation_id: 'cascade-1',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  ]);
});

test('emits trajectory_meta and trajectory_metadata_blob rows per the wire contract', async () => {
  const file = await makeGeminiDb();
  await collectGeminiConversation(file, ctx(buffer));

  const byTable = new Map(readBatches(buffer).map((b) => [b.watermark_table, b]));

  const metaBatch = byTable.get('trajectory_meta');
  if (metaBatch === undefined) throw new Error('missing trajectory_meta batch');
  expect(decodeBody(metaBatch)).toEqual([
    { idx: 1, trajectory_id: 'traj-1', cascade_id: 'cascade-1', trajectory_type: 4, source: 17 },
  ]);

  const blobBatch = byTable.get('trajectory_metadata_blob');
  if (blobBatch === undefined) throw new Error('missing trajectory_metadata_blob batch');
  expect(decodeBody(blobBatch)).toEqual([
    { idx: 1, workspace_path: 'file:///Users/me/repo', git_remote: 'git@github.com:org/repo.git' },
  ]);
});

test('advances the steps watermark and is idempotent on a second poll', async () => {
  const file = await makeGeminiDb();
  await collectGeminiConversation(file, ctx(buffer));

  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'steps',
  });
  expect(cursor?.watermarkEnd).toBe(3);
  expect(cursor?.consecutiveErrors).toBe(0);

  const second = await collectGeminiConversation(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(second.errors).toEqual([]);
});

test('redacts secrets in decoded user text before emitting (decode-before-redact)', async () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const file = await makeGeminiDb({ userText: `please use my token ${secret} now` });
  await collectGeminiConversation(file, ctx(buffer));

  const stepsBatch = readBatches(buffer).find((b) => b.watermark_table === 'steps');
  if (stepsBatch === undefined) throw new Error('missing steps batch');
  const bodyText = DECODER.decode(zstdDecompressSync(stepsBatch.body));
  expect(bodyText).not.toContain(secret);
  expect(bodyText).toContain('[REDACTED:github-pat]');
});

test('records a per-table error and bumps that table cursor when one table read throws', async () => {
  const file = await makeGeminiDb();

  const originalQuery = Database.prototype.query;
  Database.prototype.query = function (this: SqliteDatabase, sql: string) {
    if (sql.includes('FROM "steps" WHERE rowid >')) {
      throw new Error('injected steps read failure');
    }
    return originalQuery.call(this, sql);
  } as typeof Database.prototype.query;

  let result;
  try {
    result = await collectGeminiConversation(file, ctx(buffer));
  } finally {
    Database.prototype.query = originalQuery;
  }

  expect(result.errors.some((e) => e.table === 'steps')).toBe(true);
  expect(result.capturedBatches).toBe(2);

  const stepsCursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'steps',
  });
  expect(stepsCursor?.consecutiveErrors).toBe(1);

  const metaCursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'trajectory_meta',
  });
  expect(metaCursor?.consecutiveErrors).toBe(0);
});

test('bumps consecutive_errors when the source database is corrupt', async () => {
  const path = join(dir, 'broken.db');
  await Bun.write(path, 'this is not a sqlite database at all');
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  const file: DiscoveredGeminiFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    sourcePlatform: 'antigravity-cli',
    conversationId: '',
  };

  const result = await collectGeminiConversation(file, ctx(buffer));
  expect(result.errors.length).toBeGreaterThan(0);

  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(1);
});

async function makeLargeGeminiDb(count: number): Promise<DiscoveredGeminiFile> {
  const path = join(dir, 'cascade-large.db');
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)',
  );
  db.run(
    'CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)',
  );
  db.run('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
  const insertStep = db.query(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)',
  );
  const largeBlob = new Uint8Array(1024);
  for (let i = 0; i < count; i += 1) {
    insertStep.run(i, 14, 3, largeBlob);
  }
  db.query('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('traj-1', 'cascade-1', 4, 17);
  db.query('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', metadataBlob());
  db.close();
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
    sourcePlatform: 'antigravity-cli',
    conversationId: '',
  };
}

test('vacuum convergence and advance tests', async () => {
  const file = await makeLargeGeminiDb(200);
  const res1 = await collectGeminiConversation(file, ctx(buffer));
  expect(res1.capturedBatches).toBeGreaterThan(0);
  const baseCursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'trajectory_meta',
  });
  expect(baseCursor).not.toBeNull();
  const db1 = new Database(file.sourcePath);
  db1.run('DELETE FROM steps');
  db1.run('VACUUM');
  db1.close();
  const res2 = await collectGeminiConversation(file, ctx(buffer));
  expect(res2.capturedBatches).toBeGreaterThan(0);
  const gen1Hash = sha256Hex(`${file.sourcePath}#gen=1`);
  const gen1Cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: gen1Hash,
    sourceInode: null,
    watermarkTable: 'trajectory_meta',
  });
  expect(gen1Cursor).not.toBeNull();
  const res3 = await collectGeminiConversation(file, ctx(buffer));
  expect(res3.capturedBatches).toBe(0);
  const gen2CursorMissing = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: sha256Hex(`${file.sourcePath}#gen=2`),
    sourceInode: null,
    watermarkTable: 'trajectory_meta',
  });
  expect(gen2CursorMissing).toBeNull();
  const db2 = new Database(file.sourcePath);
  db2.run('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)', [
    10,
    14,
    1,
    userPayload('more text'),
  ]);
  db2.close();
  const res4 = await collectGeminiConversation(file, ctx(buffer));
  expect(res4.capturedBatches).toBe(1);
  const db3 = new Database(file.sourcePath);
  db3.run('DELETE FROM steps WHERE idx = 10');
  db3.run('VACUUM');
  db3.close();
  const res5 = await collectGeminiConversation(file, ctx(buffer));
  expect(res5.capturedBatches).toBeGreaterThan(0);
  const gen2Hash = sha256Hex(`${file.sourcePath}#gen=2`);
  const gen2Cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: gen2Hash,
    sourceInode: null,
    watermarkTable: 'trajectory_meta',
  });
  expect(gen2Cursor).not.toBeNull();
});
