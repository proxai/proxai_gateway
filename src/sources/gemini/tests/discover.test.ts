import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { discoverGeminiTranscripts } from 'sources/gemini';

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
