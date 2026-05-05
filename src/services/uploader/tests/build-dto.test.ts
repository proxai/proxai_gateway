import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { zstdDecompressSync } from 'core/utils';
import { getBatch, insertBatch, openInMemoryBufferDb } from 'services/buffer';
import { validateRawRecordDTO } from 'services/contract';
import { buildRawRecordDTO } from 'services/uploader';
import {
  newClaudeCodeBatch,
  newCodexStateBatch,
  newCursorBatch,
  TEST_HOST_ID,
} from 'services/uploader/tests/fixtures.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('produces a DTO that passes contract validation (claude-code)', () => {
  const batch = newClaudeCodeBatch('{"hello":"world"}\n');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(() => validateRawRecordDTO(dto)).not.toThrow();
});

test('host_id is set from the context arg, not from the batch', () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, 'h_custom');
  expect(dto.host_id).toBe('h_custom');
});

test('preserves capture metadata fields verbatim', () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(dto.capture_id).toBe(stored.captureId);
  expect(dto.source_app).toBe(stored.sourceApp);
  expect(dto.source_kind).toBe(stored.sourceKind);
  expect(dto.source_path).toBe(stored.sourcePath);
  expect(dto.source_path_hash).toBe(stored.sourcePathHash);
  expect(dto.source_inode).toBe(stored.sourceInode);
  expect(dto.agent_schema_version).toBe(stored.agentSchemaVersion);
  expect(dto.gateway_version).toBe(stored.gatewayVersion);
  expect(dto.captured_at_utc).toBe(stored.capturedAtUtc);
  expect(dto.body_format).toBe(stored.bodyFormat);
  expect(dto.body_compression).toBe(stored.bodyCompression);
});

test('byte_range watermark omits table', () => {
  const batch = newClaudeCodeBatch('payload', { watermarkStart: 100, watermarkEnd: 250 });
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(dto.watermark.kind).toBe('byte_range');
  expect(dto.watermark.start).toBe(100);
  expect(dto.watermark.end).toBe(250);
  expect(dto.watermark.table).toBeNull();
});

test('rowid_range watermark with null table (cursor kv snapshot)', () => {
  const batch = newCursorBatch('{"composerData:abc":"..."}', {
    watermarkStart: 5,
    watermarkEnd: 42,
  });
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(dto.watermark.kind).toBe('rowid_range');
  expect(dto.watermark.start).toBe(5);
  expect(dto.watermark.end).toBe(42);
  expect(dto.watermark.table).toBeNull();
});

test('rowid_range watermark with table (codex state)', () => {
  const batch = newCodexStateBatch('{"id":1}\n', {
    watermarkStart: 1,
    watermarkEnd: 11,
    watermarkTable: 'thread_dynamic_tools',
  });
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(dto.watermark.kind).toBe('rowid_range');
  expect(dto.watermark.table).toBe('thread_dynamic_tools');
});

test('body is base64-encoded recompressed bytes that decode back to redacted text', () => {
  const batch = newClaudeCodeBatch('hello world payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  expect(dto.body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

  const decoded = Buffer.from(dto.body, 'base64');
  const decompressed = new TextDecoder().decode(zstdDecompressSync(decoded));
  expect(decompressed).toBe('hello world payload');
});

test('applies Stage 2 redaction (TRAVIS_TOKEN keyword-anchored secret)', () => {
  const text = 'TRAVIS_TOKEN=AbCdEfGhIjKlMnOpQrStUv';
  const batch = newClaudeCodeBatch(text);
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const dto = buildRawRecordDTO(stored, TEST_HOST_ID);
  const decoded = Buffer.from(dto.body, 'base64');
  const decompressed = new TextDecoder().decode(zstdDecompressSync(decoded));
  expect(decompressed).toContain('[REDACTED:travis-ci-token]');
  expect(decompressed).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
});

test('does not mutate the stored batch (body bytes unchanged)', () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const before = getBatch(db, batch.captureId)!.body;

  buildRawRecordDTO(getBatch(db, batch.captureId)!, TEST_HOST_ID);
  const after = getBatch(db, batch.captureId)!.body;
  expect(after).toEqual(before);
});
