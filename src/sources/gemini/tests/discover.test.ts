import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { discoverGeminiTranscripts } from 'sources/gemini';

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
