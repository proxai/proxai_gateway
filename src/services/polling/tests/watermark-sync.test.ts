import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { countCursors, getCursor, openInMemoryBufferDb, setCursor } from 'services/buffer';
import { HttpClient } from 'services/http';
import type { HttpEndpoints } from 'services/http';
import { syncServerWatermarks } from 'services/polling';

const endpoints: HttpEndpoints = {
  ingest: 'https://api.example.com/v1/raw_records',
  verifyKey: 'https://api.example.com/ingestion/verify-key',
  watermarks: 'https://api.example.com/v1/watermarks',
  registerHostId: 'https://api.example.com/v1/host-ids/register',
};

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

function clientWith(body: unknown, status = 200): HttpClient {
  return new HttpClient({
    apiKey: 'k',
    hostId: 'h_test',
    endpoints,
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
}

test('seeds local cursors from server watermarks on empty buffer', async () => {
  const http = clientWith({
    host_id: 'h_test',
    user_id: 'u_1',
    watermarks: [
      {
        source_app: 'claude-code',
        source_path_hash: 'h1',
        watermark_kind: 'byte_range',
        watermark_end: 5000,
        watermark_table: null,
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
      {
        source_app: 'codex',
        source_path_hash: 'h2',
        watermark_kind: 'rowid_range',
        watermark_end: 100,
        watermark_table: 'threads',
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
    ],
  });

  const result = await syncServerWatermarks({ buffer: db, http });

  expect(result.fetched).toBe(2);
  expect(result.applied).toBe(2);
  expect(result.skipped).toBe(0);
  expect(countCursors(db)).toBe(2);

  const claude = getCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'h1',
    sourceInode: null,
    watermarkTable: null,
  });
  expect(claude?.watermarkEnd).toBe(5000);

  const codex = getCursor(db, {
    sourceApp: 'codex',
    sourcePathHash: 'h2',
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(codex?.watermarkEnd).toBe(100);
});

test('returns zero applied when server reports no watermarks', async () => {
  const http = clientWith({ host_id: 'h_test', user_id: 'u_1', watermarks: [] });
  const result = await syncServerWatermarks({ buffer: db, http });
  expect(result).toEqual({ fetched: 0, applied: 0, skipped: 0 });
  expect(countCursors(db)).toBe(0);
});

test('skips watermarks for unknown source apps', async () => {
  const http = clientWith({
    host_id: 'h_test',
    user_id: 'u_1',
    watermarks: [
      {
        source_app: 'jetbrains',
        source_path_hash: 'h1',
        watermark_kind: 'byte_range',
        watermark_end: 1,
        watermark_table: null,
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
    ],
  });
  const result = await syncServerWatermarks({ buffer: db, http });
  expect(result.fetched).toBe(1);
  expect(result.applied).toBe(0);
  expect(result.skipped).toBe(1);
  expect(countCursors(db)).toBe(0);
});

test('overwrites pre-existing local cursor (server is authoritative)', async () => {
  setCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'h1',
    sourcePath: '/tmp/sess.jsonl',
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 100,
  });
  expect(countCursors(db)).toBe(1);

  const http = clientWith({
    host_id: 'h_test',
    user_id: 'u_1',
    watermarks: [
      {
        source_app: 'claude-code',
        source_path_hash: 'h1',
        watermark_kind: 'byte_range',
        watermark_end: 9000,
        watermark_table: null,
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
    ],
  });
  const result = await syncServerWatermarks({ buffer: db, http });
  expect(result.applied).toBe(1);
  const cursor = getCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'h1',
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(9000);
});

test('synced cursors are visible via inode-fallback lookup', async () => {
  const http = clientWith({
    host_id: 'h_test',
    user_id: 'u_1',
    watermarks: [
      {
        source_app: 'claude-code',
        source_path_hash: 'h1',
        watermark_kind: 'byte_range',
        watermark_end: 5000,
        watermark_table: null,
        last_delivered_at: '2026-04-29T10:42:00Z',
      },
    ],
  });
  await syncServerWatermarks({ buffer: db, http });

  const exact = getCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'h1',
    sourceInode: 12345,
    watermarkTable: null,
  });
  expect(exact).toBeNull();

  const sentinel = getCursor(db, {
    sourceApp: 'claude-code',
    sourcePathHash: 'h1',
    sourceInode: null,
    watermarkTable: null,
  });
  expect(sentinel?.watermarkEnd).toBe(5000);
});

test('propagates auth errors to the caller', async () => {
  const http = new HttpClient({
    apiKey: 'k',
    hostId: 'h_test',
    endpoints,
    fetch: async () => new Response('', { status: 401 }),
  });
  await expect(syncServerWatermarks({ buffer: db, http })).rejects.toThrow();
});
