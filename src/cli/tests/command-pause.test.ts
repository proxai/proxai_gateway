import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPause } from 'cli/command-pause.ts';
import { captureOutput } from 'cli/output.ts';
import { isPaused, readPauseReason } from 'services/polling';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-pause-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('creates the sentinel and reports success without reason', async () => {
  const out = captureOutput();
  const sentinelPath = join(dir, 'PAUSED');
  const result = await runPause({ output: out, sentinelPath });
  expect(result.exitCode).toBe(0);
  expect(await isPaused(sentinelPath)).toBe(true);
  expect(out.lines.some((l) => l.level === 'success' && l.msg === 'paused')).toBe(true);
});

test('creates the sentinel with a reason and includes it in output', async () => {
  const out = captureOutput();
  const sentinelPath = join(dir, 'PAUSED');
  const result = await runPause({ output: out, sentinelPath }, { reason: 'manual' });
  expect(result.exitCode).toBe(0);
  expect(await readPauseReason(sentinelPath)).toBe('manual');
  expect(out.lines.some((l) => l.msg.includes('manual'))).toBe(true);
});

test('creates parent directory if missing', async () => {
  const out = captureOutput();
  const sentinelPath = join(dir, 'nested', 'deep', 'PAUSED');
  const result = await runPause({ output: out, sentinelPath });
  expect(result.exitCode).toBe(0);
  expect(await isPaused(sentinelPath)).toBe(true);
});
