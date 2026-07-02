import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { discoverGeminiConversationDbs, discoverGeminiTranscripts } from 'sources/gemini';

/** Seed <dir>/conversations/<uuid>.db with a gen_metadata table. */
async function seedConversationDb(baseDir: string, uuid: string): Promise<string> {
  const convDir = join(baseDir, 'conversations');
  await mkdir(convDir, { recursive: true });
  const path = join(convDir, `${uuid}.db`);
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)`);
  db.query('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
    0,
    new Uint8Array([1, 2, 3]),
    3,
  );
  db.close();
  return path;
}

/** Seed <dir>/brain/<uuid>/.system_generated/logs/transcript.jsonl, return its absolute path. */
async function seedTranscript(baseDir: string, uuid: string): Promise<string> {
  const transcriptDir = join(baseDir, 'brain', uuid, '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  const path = join(transcriptDir, 'transcript.jsonl');
  await Bun.write(path, '{"source":"USER_EXPLICIT","type":"USER_INPUT","text":"hi"}\n');
  return path;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-discover-'));
});

afterEach(async () => {
  await rmRecursive(dir);
}, 30_000);

it('discovers transcript.jsonl under the hidden .system_generated dir (dot:true)', async () => {
  // Build <dir>/brain/conv-uuid-1/.system_generated/logs/transcript.jsonl
  // The .system_generated segment is a hidden (dotted) directory — Bun.Glob skips it unless dot:true.
  const transcriptDir = join(dir, 'brain', 'conv-uuid-1', '.system_generated', 'logs');
  await mkdir(transcriptDir, { recursive: true });
  await Bun.write(join(transcriptDir, 'transcript.jsonl'), '{"role":"user","text":"hello"}\n');

  const files = await discoverGeminiTranscripts(dir, { minimumMtime: null });
  expect(files).toHaveLength(1);
  expect(files[0]?.conversationId).toBe('conv-uuid-1');
  expect(files[0]?.sourcePlatform).toBe('antigravity-ide');
  expect(files[0]?.sourcePath.endsWith('transcript.jsonl')).toBe(true);
});

it('skips transcripts older than minimumMtime, keeps newer ones', async () => {
  const oldPath = await seedTranscript(dir, 'conv-old');
  const newPath = await seedTranscript(dir, 'conv-new');

  const oldEpoch = new Date('2024-01-01T00:00:00Z');
  const newEpoch = new Date();
  await utimes(oldPath, oldEpoch, oldEpoch);
  await utimes(newPath, newEpoch, newEpoch);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const files = await discoverGeminiTranscripts(dir, { minimumMtime: cutoff });
  expect(files).toHaveLength(1);
  expect(files[0]?.sourcePath).toBe(newPath);
  expect(files[0]?.conversationId).toBe('conv-new');
});

it('returns [] when minimumMtime is in the future (everything is older)', async () => {
  const path = await seedTranscript(dir, 'conv-recent');
  const now = new Date();
  await utimes(path, now, now);

  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const files = await discoverGeminiTranscripts(dir, { minimumMtime: future });
  expect(files).toEqual([]);
});

it('discovers a conversation .db paired with a transcript, aligning on the content chat_id', async () => {
  const uuid = 'conv-uuid-9';
  await seedConversationDb(dir, uuid);
  await seedTranscript(dir, uuid);

  const dbs = await discoverGeminiConversationDbs(dir, { minimumMtime: null });
  expect(dbs).toHaveLength(1);
  expect(dbs[0]?.conversationId).toBe(uuid);
  expect(dbs[0]?.dbPath.endsWith(`${uuid}.db`)).toBe(true);
  expect(dbs[0]?.transcriptSourcePath.endsWith('transcript.jsonl')).toBe(true);

  // The token capture MUST land on the same chat as the content capture: its
  // transcriptSourcePathHash equals the content discovery's sourcePathHash.
  const transcripts = await discoverGeminiTranscripts(dir, { minimumMtime: null });
  const content = transcripts.find((t) => t.conversationId === uuid);
  expect(dbs[0]?.transcriptSourcePathHash).toBe(content?.sourcePathHash);
});

it('skips a conversation .db with no paired transcript', async () => {
  await seedConversationDb(dir, 'conv-orphan');
  const dbs = await discoverGeminiConversationDbs(dir, { minimumMtime: null });
  expect(dbs).toEqual([]);
});
