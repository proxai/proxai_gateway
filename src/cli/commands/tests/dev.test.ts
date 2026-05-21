import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { runDev } from 'cli/commands/dev.ts';
import { captureOutput } from 'cli/output.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';

const mockSentinelPath = join(tmpdir(), `DEV_MODE_CMD_TEST_${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
  }
});

afterEach(() => {
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
  }
});

test('runDev action="on" enables dev mode', async () => {
  const out = captureOutput();
  const result = await runDev(
    {
      output: out,
      sentinelPath: mockSentinelPath,
    },
    'on',
  );

  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(true);
  const successMsgs = out.lines.filter((l) => l.level === 'success').map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode enabled');
});

test('runDev action="off" disables dev mode', async () => {
  const out = captureOutput();
  await runDev({ output: out, sentinelPath: mockSentinelPath }, 'on');
  expect(existsSync(mockSentinelPath)).toBe(true);

  out.lines.length = 0;
  const result = await runDev(
    {
      output: out,
      sentinelPath: mockSentinelPath,
    },
    'off',
  );

  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(false);
  const successMsgs = out.lines.filter((l) => l.level === 'success').map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode disabled');
});

test('runDev toggles dev mode (action undefined)', async () => {
  const out = captureOutput();

  let result = await runDev({
    output: out,
    sentinelPath: mockSentinelPath,
  });
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(true);
  let successMsgs = out.lines.filter((l) => l.level === 'success').map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode enabled');

  out.lines.length = 0;
  result = await runDev({
    output: out,
    sentinelPath: mockSentinelPath,
  });
  expect(result.exitCode).toBe(EXIT_CODE.ok);
  expect(existsSync(mockSentinelPath)).toBe(false);
  successMsgs = out.lines.filter((l) => l.level === 'success').map((l) => l.msg);
  expect(successMsgs.join(' ')).toContain('Dev mode disabled');
});

test('runDev returns error for invalid action', async () => {
  const out = captureOutput();
  const result = await runDev(
    {
      output: out,
      sentinelPath: mockSentinelPath,
    },
    'invalid',
  );

  expect(result.exitCode).toBe(EXIT_CODE.error);
  expect(existsSync(mockSentinelPath)).toBe(false);
  const errorMsgs = out.lines.filter((l) => l.level === 'error').map((l) => l.msg);
  expect(errorMsgs.join(' ')).toContain("Invalid action: 'invalid'");
});
