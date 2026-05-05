import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runResume } from 'cli/command-resume.ts';
import { captureOutput } from 'cli/output.ts';
import { isPaused, pausePolling } from 'services/polling';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-resume-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('removes the sentinel and reports success when paused', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  await pausePolling(sentinelPath, 'reason');
  const out = captureOutput();
  const result = await runResume({ output: out, sentinelPath });
  expect(result.exitCode).toBe(0);
  expect(await isPaused(sentinelPath)).toBe(false);
  expect(out.lines.some((l) => l.level === 'success' && l.msg === 'resumed')).toBe(true);
});

test('reports nothing-to-do when not currently paused', async () => {
  const sentinelPath = join(dir, 'PAUSED');
  const out = captureOutput();
  const result = await runResume({ output: out, sentinelPath });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.level === 'info' && l.msg.includes('nothing to do'))).toBe(true);
});
