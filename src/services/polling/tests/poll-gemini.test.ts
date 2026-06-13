import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { countByStatus, openInMemoryBufferDb } from 'services/buffer';
import { makeGeminiSourcePoller } from 'services/polling/poll-gemini.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-gemini-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  return out;
}

function field(fieldNumber: number, wire: number, body: number[]): number[] {
  return [...encodeVarint((fieldNumber << 3) | wire), ...body];
}

function strField(fieldNumber: number, text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return field(fieldNumber, 2, [...encodeVarint(bytes.length), ...bytes]);
}

function msgField(fieldNumber: number, parts: number[]): number[] {
  return field(fieldNumber, 2, [...encodeVarint(parts.length), ...parts]);
}

function userPayload(text: string): Uint8Array {
  return Uint8Array.from([
    ...field(1, 0, encodeVarint(14)),
    ...msgField(5, [
      ...msgField(1, [...field(1, 0, encodeVarint(1781035381)), ...field(2, 0, encodeVarint(0))]),
      ...field(3, 0, encodeVarint(4)),
      ...msgField(20, [
        ...strField(1, 'traj-1'),
        ...field(2, 0, encodeVarint(0)),
        ...strField(4, 'cascade-1'),
      ]),
    ]),
    ...msgField(19, [...strField(2, text)]),
  ]);
}

async function seedGeminiDb(baseDir: string, name: string, text: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  const db = new Database(join(baseDir, name), { create: true });
  db.run(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)',
  );
  db.query('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(
    0,
    14,
    3,
    userPayload(text),
  );
  db.close();
}

test('returns a zero result when both roots are missing', async () => {
  const poller = makeGeminiSourcePoller({
    cliBaseDir: join(dir, 'missing-cli'),
    ideBaseDir: join(dir, 'missing-ide'),
  });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
});

test('collects conversations discovered under both cli and ide roots', async () => {
  const cliDir = join(dir, 'cli');
  const ideDir = join(dir, 'ide');
  await seedGeminiDb(cliDir, 'cascade-cli.db', 'fix the cli bug');
  await seedGeminiDb(ideDir, 'cascade-ide.db', 'fix the ide bug');

  const poller = makeGeminiSourcePoller({ cliBaseDir: cliDir, ideBaseDir: ideDir });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    minimumMtimeOverride: null,
  });

  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);
  expect(countByStatus(buffer).pending).toBe(result.capturedBatches);

  const platforms = buffer
    .query<{ source_platform: string | null }, []>(
      'SELECT DISTINCT source_platform FROM upload_batches',
    )
    .all()
    .map((r) => r.source_platform);
  expect(platforms).toContain('antigravity-cli');
  expect(platforms).toContain('antigravity-ide');
});

test('forwards per-file collect errors into the poller result', async () => {
  const cliDir = join(dir, 'cli');
  await seedGeminiDb(cliDir, 'cascade-cli.db', 'a prompt');

  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();

  const poller = makeGeminiSourcePoller({
    cliBaseDir: cliDir,
    ideBaseDir: join(dir, 'missing-ide'),
  });
  const result = await poller({
    buffer: closedBuffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.errors.length).toBeGreaterThan(0);
});

test('records discovery errors when a root path is invalid', async () => {
  const poller = makeGeminiSourcePoller({
    cliBaseDir: `${join(dir, 'cli')}${String.fromCharCode(0)}sub`,
    ideBaseDir: join(dir, 'missing-ide'),
  });
  const result = await poller({
    buffer,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.some((e) => e.sourcePath.includes('cli'))).toBe(true);
});
