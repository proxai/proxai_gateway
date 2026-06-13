import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import type { MinimalLogger } from 'core/log';
import { sha256Hex, zstdDecompressSync } from 'core/utils';
import { getCursor, openInMemoryBufferDb, setCursor } from 'services/buffer';
import { collectGeminiConversation, measureGeminiUploadSize } from 'sources/gemini';
import type { DiscoveredGeminiFile, GeminiCollectorContext } from 'sources/gemini';
import { concatBytes, msgField, strField, varintField } from 'sources/gemini/tests/proto-encode.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-process-rows-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

function userPayload(text: string): Uint8Array {
  return concatBytes([
    varintField(1, 14),
    msgField(5, [
      msgField(1, [varintField(1, 1781035381), varintField(2, 0)]),
      varintField(3, 4),
      msgField(20, [strField(1, 'traj-1'), varintField(2, 0), strField(4, 'cascade-1')]),
    ]),
    msgField(19, [strField(2, text)]),
  ]);
}

interface SeedOptions {
  texts: string[];
}

async function makeStepsOnlyDb(options: SeedOptions): Promise<DiscoveredGeminiFile> {
  const path = join(dir, 'cascade-1.db');
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)',
  );
  const insertStep = db.query(
    'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)',
  );
  options.texts.forEach((text, index) => {
    insertStep.run(index, 14, 3, userPayload(text));
  });
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
  };
}

function noopLogger(): MinimalLogger {
  const logger: MinimalLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  };
  return logger;
}

function ctx(maxDecompressedBytes: number, logger?: MinimalLogger): GeminiCollectorContext {
  return {
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes,
    ...(logger !== undefined ? { logger } : {}),
  };
}

function countBatches(): number {
  return (
    buffer.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM upload_batches').get()
      ?.count ?? 0
  );
}

function countQuarantine(): number {
  return (
    buffer.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM quarantined_records').get()
      ?.count ?? 0
  );
}

async function measureSingleRowRawBytes(template: DiscoveredGeminiFile): Promise<number> {
  const probeBuffer = openInMemoryBufferDb();
  try {
    await collectGeminiConversation(template, {
      buffer: probeBuffer,
      gatewayVersion: 'gw-0.1',
      maxDecompressedBytes: 8 * 1024 * 1024,
    });
    const body = probeBuffer
      .query<
        { body: Uint8Array },
        [string]
      >('SELECT body FROM upload_batches WHERE watermark_table = ? LIMIT 1')
      .get('steps')?.body;
    if (body === undefined) throw new Error('probe produced no steps batch');
    const rows = JSON.parse(new TextDecoder().decode(zstdDecompressSync(body)));
    if (!Array.isArray(rows)) throw new Error('probe body was not an array');
    return Buffer.byteLength(JSON.stringify([rows[0]]), 'utf8');
  } finally {
    probeBuffer.close();
  }
}

test('splits an oversized step set into multiple accepted batches', async () => {
  const texts = Array.from({ length: 6 }, (_, i) => `prompt-${i.toString()}`);
  const file = await makeStepsOnlyDb({ texts });

  const singleRowRawBytes = await measureSingleRowRawBytes(file);
  const cap = singleRowRawBytes + 10;

  const result = await collectGeminiConversation(file, ctx(cap, noopLogger()));

  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBeGreaterThan(1);
  expect(countBatches()).toBe(result.capturedBatches);
  expect(countQuarantine()).toBe(0);

  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'steps',
  });
  expect(cursor?.watermarkEnd).toBe(texts.length);
  expect(cursor?.consecutiveErrors).toBe(0);
});

test('quarantines a step row whose decoded JSON exceeds the decompressed cap', async () => {
  const file = await makeStepsOnlyDb({
    texts: ['this single prompt is far too large for the cap'],
  });

  const result = await collectGeminiConversation(file, ctx(10, noopLogger()));

  expect(result.capturedBatches).toBe(0);
  expect(countBatches()).toBe(0);
  expect(countQuarantine()).toBe(1);
  expect(result.errors.some((e) => e.reason.includes('quarantined'))).toBe(true);

  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'steps',
  });
  expect(cursor?.watermarkEnd).toBe(1);
  expect(cursor?.consecutiveErrors).toBe(1);
});

test('advances past an oversized row even when the quarantine write fails', async () => {
  const file = await makeStepsOnlyDb({ texts: ['another prompt that overflows the tiny cap'] });

  const originalQuery = Database.prototype.query;
  Database.prototype.query = function (this: Database, sql: string) {
    if (sql.includes('INSERT INTO quarantined_records')) {
      throw new Error('injected quarantine write failure');
    }
    return originalQuery.call(this, sql);
  } as typeof Database.prototype.query;

  try {
    const result = await collectGeminiConversation(file, ctx(10, noopLogger()));
    expect(result.capturedBatches).toBe(0);
    expect(countQuarantine()).toBe(0);

    const cursor = getCursor(buffer, {
      sourceApp: 'gemini',
      sourcePathHash: file.sourcePathHash,
      sourceInode: null,
      watermarkTable: 'steps',
    });
    expect(cursor?.watermarkEnd).toBe(1);
    expect(cursor?.consecutiveErrors).toBe(1);
  } finally {
    Database.prototype.query = originalQuery;
  }
});

test('keeps prior watermark and clears errors when no new rows exist', async () => {
  const file = await makeStepsOnlyDb({ texts: ['first prompt', 'second prompt'] });
  await collectGeminiConversation(file, ctx(8 * 1024 * 1024));

  const second = await collectGeminiConversation(file, ctx(8 * 1024 * 1024));
  expect(second.capturedBatches).toBe(0);
  expect(second.errors).toEqual([]);

  const cursor = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'steps',
  });
  expect(cursor?.watermarkEnd).toBe(2);
  expect(cursor?.consecutiveErrors).toBe(0);
});

test('measureGeminiUploadSize sizes the payload and skips absent tables', async () => {
  const file = await makeStepsOnlyDb({ texts: ['hello world', 'a second prompt', 'third turn'] });
  const db = new Database(file.sourcePath, { readonly: true });
  try {
    const size = measureGeminiUploadSize(db, 8 * 1024 * 1024);
    expect(size.telemetryRecordCount).toBe(3);
    expect(size.rawBytes).toBeGreaterThan(0);
    expect(size.compressedBytes).toBeGreaterThan(0);
    expect(size.compressedBytes).toBeLessThan(size.rawBytes);
  } finally {
    db.close();
  }
});

test('measureGeminiUploadSize returns zero for an empty steps table', async () => {
  const file = await makeStepsOnlyDb({ texts: [] });
  const db = new Database(file.sourcePath, { readonly: true });
  try {
    const size = measureGeminiUploadSize(db, 8 * 1024 * 1024);
    expect(size).toEqual({ telemetryRecordCount: 0, rawBytes: 0, compressedBytes: 0 });
  } finally {
    db.close();
  }
});

test('measureGeminiUploadSize skips slices that exceed the decompressed cap', async () => {
  const file = await makeStepsOnlyDb({ texts: ['hello world', 'a second prompt'] });
  const db = new Database(file.sourcePath, { readonly: true });
  try {
    const size = measureGeminiUploadSize(db, 1);
    expect(size).toEqual({ telemetryRecordCount: 0, rawBytes: 0, compressedBytes: 0 });
  } finally {
    db.close();
  }
});

test('clears a stale file-level error cursor after a successful capture', async () => {
  const file = await makeStepsOnlyDb({ texts: ['recovered prompt'] });
  setCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 24,
  });
  const before = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(before?.consecutiveErrors).toBe(24);

  const result = await collectGeminiConversation(file, ctx(8 * 1024 * 1024));
  expect(result.errors).toEqual([]);

  const after = getCursor(buffer, {
    sourceApp: 'gemini',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(after?.consecutiveErrors).toBe(0);
});
