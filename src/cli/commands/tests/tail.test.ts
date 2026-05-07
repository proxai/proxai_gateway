import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTail, todaysLogPath, formatLine } from 'cli/commands/tail.ts';
import { captureOutput } from 'cli/output.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-tail-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeLine(level: number, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ level, time: Date.now(), msg, ...extra });
}

async function seedTodaysLog(content: string): Promise<string> {
  const path = todaysLogPath(dir);
  await writeFile(path, content);
  return path;
}

test('emits last N lines when not following', async () => {
  await seedTodaysLog([makeLine(30, 'a'), makeLine(30, 'b'), makeLine(30, 'c')].join('\n') + '\n');
  const lines: string[] = [];
  const result = await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { lines: 2, json: true },
  );
  expect(result.exitCode).toBe(0);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).msg).toBe('b');
  expect(JSON.parse(lines[1]!).msg).toBe('c');
});

test('returns 0 with no output when log file is missing', async () => {
  const lines: string[] = [];
  const result = await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { lines: 50, json: true },
  );
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual([]);
});

test('--source filters by source_app', async () => {
  await seedTodaysLog(
    [
      makeLine(30, 'cc-line', { source_app: 'claude-code' }),
      makeLine(30, 'cur-line', { source_app: 'cursor' }),
      makeLine(30, 'cc-line-2', { source_app: 'claude-code' }),
    ].join('\n') + '\n',
  );
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { source: 'claude-code', json: true },
  );
  expect(lines).toHaveLength(2);
  expect(lines.every((l) => JSON.parse(l).source_app === 'claude-code')).toBe(true);
});

test('--level filters out lines below threshold', async () => {
  await seedTodaysLog(
    [
      makeLine(20, 'debug-line'),
      makeLine(30, 'info-line'),
      makeLine(40, 'warn-line'),
      makeLine(50, 'error-line'),
    ].join('\n') + '\n',
  );
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { level: 'warn', json: true },
  );
  expect(lines).toHaveLength(2);
  expect(lines.every((l) => JSON.parse(l).level >= 40)).toBe(true);
});

test('--since filters by time window', async () => {
  const now = Date.now();
  const old = JSON.stringify({ level: 30, time: now - 7_200_000, msg: 'old' });
  const recent = JSON.stringify({ level: 30, time: now - 60_000, msg: 'recent' });
  await seedTodaysLog([old, recent].join('\n') + '\n');
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { since: '1h', json: true },
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).msg).toBe('recent');
});

test('returns validationError on invalid --since duration', async () => {
  const out = captureOutput();
  const result = await runTail(
    { output: out, logDir: dir, emit: () => undefined },
    { since: 'forever' },
  );
  expect(result.exitCode).toBe(2);
  expect(out.lines.some((l) => l.msg.includes('invalid --since'))).toBe(true);
});

test('returns validationError on invalid --level', async () => {
  const out = captureOutput();
  const result = await runTail(
    { output: out, logDir: dir, emit: () => undefined },
    { level: 'verbose' as never },
  );
  expect(result.exitCode).toBe(2);
});

test('--json passthrough emits raw lines unmodified', async () => {
  const raw = makeLine(30, 'hello', { source_app: 'cursor' });
  await seedTodaysLog(`${raw}\n`);
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { json: true },
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toBe(raw);
});

test('without --json, applies pretty formatting', async () => {
  await seedTodaysLog(`${makeLine(30, 'pretty-test', { source_app: 'cursor' })}\n`);
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { json: false },
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('pretty-test');
  expect(lines[0]).toContain('cursor');
  expect(lines[0]).toContain('INFO');
});

test('--follow emits new lines and stops on abort', async () => {
  await seedTodaysLog(`${makeLine(30, 'first')}\n`);
  const ctrl = new AbortController();
  const lines: string[] = [];

  const promise = runTail(
    {
      output: captureOutput(),
      logDir: dir,
      emit: (l) => lines.push(l),
      abortSignal: ctrl.signal,
      pollIntervalMs: 1,
    },
    { follow: true, json: true },
  );
  await Bun.sleep(10);
  await Bun.write(todaysLogPath(dir), `${makeLine(30, 'first')}\n${makeLine(30, 'second')}\n`);
  await Bun.sleep(20);
  ctrl.abort();
  const result = await promise;

  expect(result.exitCode).toBe(0);
  expect(lines.some((l) => JSON.parse(l).msg === 'second')).toBe(true);
});

test('--follow exits immediately when signal is already aborted', async () => {
  await seedTodaysLog(`${makeLine(30, 'first')}\n`);
  const ctrl = new AbortController();
  ctrl.abort();
  const lines: string[] = [];
  const result = await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l), abortSignal: ctrl.signal },
    { follow: true, json: true },
  );
  expect(result.exitCode).toBe(0);
});

test('--follow handles missing log file gracefully (exits cleanly on abort)', async () => {
  const ctrl = new AbortController();
  const lines: string[] = [];
  const promise = runTail(
    {
      output: captureOutput(),
      logDir: dir,
      emit: (l) => lines.push(l),
      abortSignal: ctrl.signal,
      pollIntervalMs: 1,
    },
    { follow: true, json: true },
  );
  await Bun.sleep(20);
  ctrl.abort();
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual([]);
});

test('formatLine returns the original string when JSON parse fails', () => {
  const raw = 'not-valid-json';
  expect(formatLine(raw)).toBe(raw);
});

test('formatLine produces a colored, structured line for valid input', () => {
  const raw = JSON.stringify({
    level: 50,
    time: Date.parse('2026-05-05T14:32:08Z'),
    msg: 'something failed',
    source_app: 'claude-code',
    capture_id: '01943f5a',
  });
  const out = formatLine(raw);
  expect(out).toContain('2026-05-05 14:32:08');
  expect(out).toContain('ERROR');
  expect(out).toContain('claude-code');
  expect(out).toContain('something failed');
  expect(out).toContain('capture_id');
});

test('todaysLogPath uses the current UTC date', () => {
  const path = todaysLogPath('/some/dir');
  const today = new Date().toISOString().slice(0, 10);
  expect(path).toContain(`structured.${today}.1.log`);
});

test('parses different --since unit suffixes (s, m, h, d)', async () => {
  const now = Date.now();
  await seedTodaysLog(
    [
      JSON.stringify({ level: 30, time: now - 5_000, msg: 'recent' }),
      JSON.stringify({ level: 30, time: now - 86_400_000 - 5_000, msg: 'older' }),
    ].join('\n') + '\n',
  );
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { since: '1d', json: true },
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).msg).toBe('recent');
});

test('formatLine renders trace, debug, info, warn, error, fatal levels', () => {
  
  
  const trace = formatLine(JSON.stringify({ level: 10, time: Date.now(), msg: 't' }));
  expect(trace).toContain('TRACE');
  const debug = formatLine(JSON.stringify({ level: 20, time: Date.now(), msg: 'd' }));
  expect(debug).toContain('DEBUG');
  const info = formatLine(JSON.stringify({ level: 30, time: Date.now(), msg: 'i' }));
  expect(info).toContain('INFO');
  const warn = formatLine(JSON.stringify({ level: 40, time: Date.now(), msg: 'w' }));
  expect(warn).toContain('WARN');
  const error = formatLine(JSON.stringify({ level: 50, time: Date.now(), msg: 'e' }));
  expect(error).toContain('ERROR');
  const fatal = formatLine(JSON.stringify({ level: 60, time: Date.now(), msg: 'f' }));
  expect(fatal).toContain('FATAL');
});

test('formatLine handles unknown level by falling through to numeric label', () => {
  const out = formatLine(JSON.stringify({ level: 25, time: Date.now(), msg: 'x' }));
  expect(out).toContain('25');
});

test('--follow resets read position when the log file rotates mid-loop', async () => {
  
  
  const pathA = join(dir, 'rotA.log');
  const pathB = join(dir, 'rotB.log');
  await Bun.write(pathA, `${makeLine(30, 'pre-rotate')}\n`);

  let calls = 0;
  const pathProvider = (): string => {
    calls++;
    return calls <= 2 ? pathA : pathB;
  };

  const ctrl = new AbortController();
  const lines: string[] = [];
  const followPromise = runTail(
    {
      output: captureOutput(),
      logDir: dir,
      emit: (l) => lines.push(l),
      abortSignal: ctrl.signal,
      pathProvider,
    },
    { follow: true, json: true },
  );
  await Bun.sleep(50);
  
  
  await Bun.write(pathB, `${makeLine(30, 'post-rotate')}\n`);
  await Bun.sleep(400);
  ctrl.abort();
  await followPromise;

  expect(lines.some((l) => JSON.parse(l).msg === 'pre-rotate')).toBe(true);
  expect(lines.some((l) => JSON.parse(l).msg === 'post-rotate')).toBe(true);
});

test('skips malformed JSON lines silently', async () => {
  await seedTodaysLog(['{not-json}', makeLine(30, 'good'), 'also-not-json'].join('\n') + '\n');
  const lines: string[] = [];
  await runTail(
    { output: captureOutput(), logDir: dir, emit: (l) => lines.push(l) },
    { json: true },
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!).msg).toBe('good');
});
