import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { collectCodexRollout } from 'sources/codex';
import type { CodexCollectorContext, DiscoveredCodexRolloutFile } from 'sources/codex';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-codex-rollout-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeFile(
  content: string,
  name = 'rollout.jsonl',
): Promise<DiscoveredCodexRolloutFile> {
  const path = join(dir, name);
  await writeFile(path, content);
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

function ctx(b: Database): CodexCollectorContext {
  return { buffer: b, gatewayVersion: '@proxai/gateway 0.1.0' };
}

const DECODER = new TextDecoder();

test('inserts a batch covering newly added complete lines', async () => {
  const file = await makeFile(
    '{"timestamp":"2026-04-29T10:00:00Z","type":"session_meta","payload":{}}\n',
  );
  const result = await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(1);
  expect(totalPendingBytes(buffer)).toBeGreaterThan(0);
});

test('advances cursor to the safe end byte', async () => {
  const content = '{"a":1}\n{"b":2}\n';
  const file = await makeFile(content);
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe(content.length);
});

test('does nothing on a second poll with no new bytes', async () => {
  const file = await makeFile('{"a":1}\n');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const second = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(second.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(1);
});

test('holds back trailing partial line and only advances to last newline', async () => {
  const file = await makeFile('{"a":1}\n{"b":');
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: file.inode,
    watermarkTable: null,
  });
  expect(cursor?.watermarkEnd).toBe('{"a":1}\n'.length);
});

test('does not insert a batch when no complete line is present', async () => {
  const file = await makeFile('{"a":');
  const result = await collectCodexRollout(file, ctx(buffer), '0.1.0');
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
});

test('uses the provided agent_schema_version verbatim', async () => {
  const file = await makeFile('{"a":1}\n');
  await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  const batch = nextPendingBatch(buffer)!;
  expect(batch.agentSchemaVersion).toBe('0.126.0-alpha.8');
});

test('redacts secrets from the body before storing', async () => {
  const file = await makeFile(
    '{"type":"event_msg","payload":{"text":"export OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt"}}\n',
  );
  await collectCodexRollout(file, ctx(buffer), '0.1.0');
  const batch = nextPendingBatch(buffer)!;
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('records errors and does not advance cursor when the file is unreadable', async () => {
  const fakeFile: DiscoveredCodexRolloutFile = {
    sourcePath: join(dir, 'does-not-exist.jsonl'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.jsonl')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const result = await collectCodexRollout(fakeFile, ctx(buffer), '0.1.0');
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeFile('{"a":1}\n');
  await collectCodexRollout(file, ctx(buffer), '0.126.0-alpha.8');
  const batch = nextPendingBatch(buffer)!;
  expect(batch.sourceApp).toBe('codex');
  expect(batch.sourceKind).toBe('jsonl_append');
  expect(batch.bodyFormat).toBe('jsonl');
  expect(batch.bodyCompression).toBe('zstd');
  expect(batch.watermarkKind).toBe('byte_range');
  expect(batch.watermarkTable).toBeNull();
  expect(batch.sourceInode).toBe(file.inode);
  expect(batch.gatewayVersion).toBe('@proxai/gateway 0.1.0');
  expect(batch.capturedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
