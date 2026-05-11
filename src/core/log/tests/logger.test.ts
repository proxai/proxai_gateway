import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DestinationStream } from 'pino';

import { createLogger, defaultLogFilePath } from 'core/log';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-log-'));
});

afterAll(async () => {
  await rmRecursive(dir);
});

function captureStream(): { lines: string[]; dest: DestinationStream } {
  const lines: string[] = [];
  const dest: DestinationStream = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  return { lines, dest };
}

test('logs JSON lines with msg and bindings', async () => {
  const { lines, dest } = captureStream();
  const logger = await createLogger({ destination: dest });
  logger.info({ foo: 'bar' }, 'hello');
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.foo).toBe('bar');
  expect(parsed.msg).toBe('hello');
});

test('respects level filter', async () => {
  const { lines, dest } = captureStream();
  const logger = await createLogger({ destination: dest, level: 'warn' });
  logger.debug('skipped');
  logger.info('skipped');
  logger.warn('captured');
  logger.error('captured');
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).msg).toBe('captured');
  expect(JSON.parse(lines[1]!).msg).toBe('captured');
});

test('child logger inherits and extends bindings', async () => {
  const { lines, dest } = captureStream();
  const root = await createLogger({ destination: dest, bindings: { service: 'gateway' } });
  const child = root.child({ source_app: 'claude-code' });
  child.info('test');
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.service).toBe('gateway');
  expect(parsed.source_app).toBe('claude-code');
});

test('default base bindings exclude pid and hostname', async () => {
  const { lines, dest } = captureStream();
  const logger = await createLogger({ destination: dest });
  logger.info('test');
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.pid).toBeUndefined();
  expect(parsed.hostname).toBeUndefined();
});

test('default level is info (debug and trace skipped)', async () => {
  const { lines, dest } = captureStream();
  const logger = await createLogger({ destination: dest });
  logger.trace('t');
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  logger.fatal('f');
  expect(lines).toHaveLength(4);
});

test('defaultLogFilePath ends with the canonical filename', () => {
  expect(defaultLogFilePath()).toMatch(/structured\.log$/);
});

test('createLogger with logDir creates a date-named file via pino-roll', async () => {
  const logDir = join(dir, 'rolled');
  const logger = await createLogger({ logDir, level: 'trace' });
  logger.info('hello-from-roll');
  await Bun.sleep(100);
  const entries = await readdir(logDir);
  const matching = entries.filter((e) => /^structured\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(e));
  expect(matching.length).toBeGreaterThan(0);
  expect(typeof logger.info).toBe('function');
});

test('createLogger uses pretty transport when pretty=true', async () => {
  const logger = await createLogger({ pretty: true, level: 'info' });
  expect(typeof logger.info).toBe('function');
  expect(typeof logger.warn).toBe('function');
});

test('createLogger uses default stdout destination when no overrides given', async () => {
  const logger = await createLogger();
  expect(typeof logger.info).toBe('function');
});
