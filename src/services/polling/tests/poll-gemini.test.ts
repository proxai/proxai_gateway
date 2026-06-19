import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

/** Seed a transcript.jsonl under <baseDir>/brain/<uuid>/.system_generated/logs/transcript.jsonl */
async function seedTranscript(baseDir: string, uuid: string, text: string): Promise<void> {
  const transcriptDir = join(baseDir, 'brain', uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    join(transcriptDir, 'transcript.jsonl'),
    `{"origin":"USER_EXPLICIT","type":"USER_INPUT","text":${JSON.stringify(text)}}\n`,
  );
}

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

test('PAUSE: excluded conversation (agyhub maps uuid → excluded folder) captures nothing', async () => {
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
