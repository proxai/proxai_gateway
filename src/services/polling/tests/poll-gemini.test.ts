import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { countByStatus, countCursors, openInMemoryBufferDb } from 'services/buffer';
import {
  GEMINI_AGYHUB_FILE,
  type DiscoveredGeminiDbFile,
  type GeminiCollectorResult,
} from 'sources/gemini';
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

/** Seed a transcript.jsonl under <baseDir>/brain/<uuid>/.system_generated/logs/transcript.jsonl */
async function seedTranscript(baseDir: string, uuid: string, text: string): Promise<void> {
  const transcriptDir = join(baseDir, 'brain', uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    join(transcriptDir, 'transcript.jsonl'),
    `{"origin":"USER_EXPLICIT","type":"USER_INPUT","text":${JSON.stringify(text)}}\n`,
  );
}

// agyhub protobuf helpers (mirror src/services/exclusion/tests/gemini-agyhub.test.ts):
// top field1=repeated entry{ field1=uuid, field2=meta{ field9=repeated root{ field1=fileUri } } }
function lp(field: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), Buffer.from([payload.length]), payload]); // len<128 in tests
}
const root = (uri: string): Buffer => lp(1, Buffer.from(uri, 'utf8'));
const meta = (uris: string[]): Buffer => Buffer.concat(uris.map((u) => lp(9, root(u))));
const entry = (uuid: string, uris: string[]): Buffer =>
  Buffer.concat([lp(1, Buffer.from(uuid)), lp(2, meta(uris))]);

const POLL_CTX = {
  gatewayVersion: 'gw-0.1',
  maxDecompressedBytes: 9 * 1024 * 1024,
} as const;

test('returns a zero result when the base dir is missing', async () => {
  const poller = makeGeminiSourcePoller({ baseDir: join(dir, 'missing') });
  const result = await poller({ buffer, ...POLL_CTX });
  expect(result.filesProcessed).toBe(0);
  expect(result.capturedBatches).toBe(0);
  expect(result.errors).toEqual([]);
});

test('collects conversations discovered under the single base dir', async () => {
  await seedTranscript(dir, 'conv-aaa', 'fix the cli bug');
  await seedTranscript(dir, 'conv-bbb', 'fix the ide bug');

  const poller = makeGeminiSourcePoller({ baseDir: dir });
  const result = await poller({ buffer, ...POLL_CTX, minimumMtimeOverride: null });

  expect(result.filesProcessed).toBe(2);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);
  expect(countByStatus(buffer).pending).toBe(result.capturedBatches);
});

test('forwards per-file collect errors into the poller result', async () => {
  await seedTranscript(dir, 'conv-err', 'a prompt');

  const closedBuffer = openInMemoryBufferDb();
  closedBuffer.close();

  const poller = makeGeminiSourcePoller({ baseDir: dir });
  const result = await poller({ buffer: closedBuffer, ...POLL_CTX });

  expect(result.errors.length).toBeGreaterThan(0);
});

test('records a discovery error when the base path contains a null byte', async () => {
  const poller = makeGeminiSourcePoller({
    baseDir: `${dir}${String.fromCharCode(0)}sub`,
  });
  const result = await poller({ buffer, ...POLL_CTX });

  expect(result.errors.length).toBeGreaterThan(0);
});

test('records a token-pass (gen_metadata) discovery error and returns without throwing', async () => {
  // The transcript pass shares baseDir, so it succeeds (empty dir → []); the
  // token-pass discovery throws → its own catch records the error.
  const poller = makeGeminiSourcePoller({
    baseDir: dir,
    deps: {
      discoverGeminiConversationDbs: async () => {
        throw new Error('db discovery boom');
      },
    },
  });
  const result = await poller({ buffer, ...POLL_CTX, minimumMtimeOverride: null });

  expect(result.errors.some((e) => e.reason.includes('db discovery boom'))).toBe(true);
});

test('runs the token pass over discovered dbs and folds their batches/bytes/errors in', async () => {
  const fakeDb: DiscoveredGeminiDbFile = {
    dbPath: join(dir, 'conversations', 'u.db'),
    transcriptSourcePath: join(dir, 'brain', 'u', '.system_generated', 'logs', 'transcript.jsonl'),
    transcriptSourcePathHash: 'deadbeef',
    conversationId: 'u',
    dbSizeBytes: 1,
    dbInode: 1,
    sourcePlatform: 'antigravity-ide',
  };
  const tokenResult: GeminiCollectorResult = {
    capturedBatches: 3,
    capturedBytes: 42,
    errors: [{ sourcePath: fakeDb.dbPath, reason: 'token oops' }],
  };
  const poller = makeGeminiSourcePoller({
    baseDir: dir,
    deps: {
      discoverGeminiConversationDbs: async () => [fakeDb],
      collectGeminiGenMetadata: async () => tokenResult,
    },
  });
  const result = await poller({ buffer, ...POLL_CTX, minimumMtimeOverride: null });

  expect(result.filesProcessed).toBe(1); // 0 transcripts + 1 token db
  expect(result.capturedBatches).toBe(3);
  expect(result.capturedBytes).toBe(42);
  expect(result.errors).toContainEqual({ sourcePath: fakeDb.dbPath, reason: 'token oops' });
});

test('fail-open plumbing: excludedProjects forwarded; a conversation with no agyhub entry still captures', async () => {
  const uuid = 'conv-secret-xyz';
  await seedTranscript(dir, uuid, 'secret prompt');

  // The agyhub file is absent (no real .pb) — so agyhubFolders is empty and the exclusion
  // gate falls through (fail-open). The collect-level exclusion test in collect.test.ts covers
  // the full pause scenario with a real agyhubFolders map threaded into the context. The
  // poller-level test here verifies the plumbing: excludedProjects is forwarded to the context
  // and a non-excluded conversation still captures normally.
  const poller = makeGeminiSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    ...POLL_CTX,
    excludedProjects: ['/Users/me/never-matches'],
    minimumMtimeOverride: null,
  });

  // agyhub absent -> empty map -> fail-open -> conversation is captured (not paused)
  expect(result.errors).toEqual([]);
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);
});

test('PAUSE: a real agyhub .pb mapping the conversation to an excluded folder captures nothing', async () => {
  const uuid = 'conv-real-pause';
  await seedTranscript(dir, uuid, 'secret prompt');

  // Write a real agyhub_summaries_proto.pb under baseDir mapping this conversation's UUID to a
  // file:// URI for the excluded folder, so the poller decodes it and the gate pauses.
  const excludedFolder = '/Users/me/secret-project';
  const pb = lp(1, entry(uuid, [`file://${excludedFolder}`]));
  await writeFile(join(dir, GEMINI_AGYHUB_FILE), pb);

  const poller = makeGeminiSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    ...POLL_CTX,
    excludedProjects: [excludedFolder],
    minimumMtimeOverride: null,
  });

  expect(result.errors).toEqual([]);
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);

  // PAUSE means the byte watermark stays frozen: no cursor row is written for the only file.
  expect(countCursors(buffer)).toBe(0);
});

test('FAIL CLOSED: present-but-empty agyhub .pb + active exclusion captures nothing, no cursor advance', async () => {
  // A transiently-empty .pb (0 bytes) under an active exclusion must NOT fall through to fail-open:
  // the excluded conversation could simply be absent from the empty index. loadAgyhubFolderMap
  // returns complete:false, which routes through the collect gate's agyhubComplete===false pause.
  const uuid = 'conv-empty-agyhub';
  await seedTranscript(dir, uuid, 'secret prompt');
  await writeFile(join(dir, GEMINI_AGYHUB_FILE), new Uint8Array(0));

  const poller = makeGeminiSourcePoller({ baseDir: dir });
  const result = await poller({
    buffer,
    ...POLL_CTX,
    excludedProjects: ['/Users/me/secret-project'],
    minimumMtimeOverride: null,
  });

  expect(result.errors).toEqual([]);
  expect(result.filesProcessed).toBe(1);
  expect(result.capturedBatches).toBe(0);
  expect(countByStatus(buffer).pending).toBe(0);
  // Fail-closed PAUSE: watermark frozen, so it backfills once the index populates.
  expect(countCursors(buffer)).toBe(0);
});
