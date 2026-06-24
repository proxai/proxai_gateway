import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zstdDecompressSync, requireDefined } from 'core/utils';
import { countByStatus, getCursor, nextPendingBatch, openInMemoryBufferDb } from 'services/buffer';
import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import { collectCursorFile } from 'sources/cursor';
import type { CursorCollectorContext } from 'sources/cursor';
import {
  COMPOSER_ONLY_FIXTURE,
  MIXED_KEY_PREFIXES_FIXTURE,
  MIXED_VERSIONS_FIXTURE,
  NO_RELEVANT_PREFIXES_FIXTURE,
  NULL_AND_MISSING_V_FIXTURE,
  REDACTION_FIXTURE,
  TYPICAL_SESSION_FIXTURE,
  writeFixtureDb,
} from 'sources/cursor/tests/fixtures/kv-fixtures.ts';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-cursor-parsing-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function ctx(b: SqliteDatabase): CursorCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0-fixture',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

const DECODER = new TextDecoder();

function bodyText(batch: { body: Uint8Array }): string {
  return DECODER.decode(zstdDecompressSync(batch.body));
}

test('typical session: composer + bubble rows derive agent_schema_version from first of each', async () => {
  const file = await writeFixtureDb(dir, TYPICAL_SESSION_FIXTURE);
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  expect(result.capturedBatches).toBe(1);
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.agentSchemaVersion).toBe(TYPICAL_SESSION_FIXTURE.expectedAgentSchemaVersion);
  const text = bodyText(batch);
  expect(text).toContain('composerData:00000000-0000-0000-0000-000000000001');
  expect(text).toContain('bubbleId:00000000-0000-0000-0000-000000000001:b-001');
  expect(text).toContain('bubbleId:00000000-0000-0000-0000-000000000001:b-003');
});

test('mixed _v values: derive from MAX of each prefix (newest schema present wins)', async () => {
  const file = await writeFixtureDb(dir, MIXED_VERSIONS_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.agentSchemaVersion).toBe(MIXED_VERSIONS_FIXTURE.expectedAgentSchemaVersion);
  expect(batch.agentSchemaVersion).toBe('15:5');
  const text = bodyText(batch);
  expect(text).toContain('\\"_v\\":10');
  expect(text).toContain('\\"_v\\":14');
  expect(text).toContain('\\"_v\\":15');
});

test('composer-only fixture: bubble half falls back to "unknown"', async () => {
  const file = await writeFixtureDb(dir, COMPOSER_ONLY_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.agentSchemaVersion).toBe('13:unknown');
});

test('no relevant prefixes: collector emits no batch at all', async () => {
  const file = await writeFixtureDb(dir, NO_RELEVANT_PREFIXES_FIXTURE);
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('null value rows and missing _v fields fall back per-prefix without erroring', async () => {
  const file = await writeFixtureDb(dir, NULL_AND_MISSING_V_FIXTURE);
  const result = await collectCursorFile(file, ctx(buffer));
  expect(result.errors).toEqual([]);
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.agentSchemaVersion).toBe(NULL_AND_MISSING_V_FIXTURE.expectedAgentSchemaVersion);
  expect(batch.agentSchemaVersion).toBe('14:3');
});

test('Stage 1 redaction is applied to fixture row content before compression', async () => {
  const file = await writeFixtureDb(dir, REDACTION_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  const text = bodyText(batch);
  expect(text).toContain('[REDACTED:openai-api-key]');
  expect(text).not.toContain('sk-AbCdEfGhIj');
});

test('non-allowlisted key prefixes are filtered out of the body', async () => {
  const file = await writeFixtureDb(dir, MIXED_KEY_PREFIXES_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  const text = bodyText(batch);
  expect(text).toContain('composerData:00000000-0000-0000-0000-000000000111');
  expect(text).toContain('bubbleId:00000000-0000-0000-0000-000000000111:b-1');
  expect(text).not.toContain('auth:tokens');
  expect(text).not.toContain('randomKey');
  expect(text).not.toContain('agentKv:blob');
  expect(text).not.toContain('checkpointId');
});

test('rowid_range watermark: start = first matching rowid, end = last matching rowid + 1', async () => {
  const file = await writeFixtureDb(dir, MIXED_KEY_PREFIXES_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.watermarkKind).toBe('rowid_range');
  expect(batch.watermarkStart).toBe(1);
  expect(batch.watermarkEnd).toBe(7);
  const cursor = getCursor(buffer, {
    sourceApp: 'cursor',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(7);
});

test('subsequent poll with no new fixture rows is a no-op', async () => {
  const file = await writeFixtureDb(dir, TYPICAL_SESSION_FIXTURE);
  await collectCursorFile(file, ctx(buffer));
  const second = await collectCursorFile(file, ctx(buffer));
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});
