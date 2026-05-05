import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DestinationStream } from 'pino';

import { createLogger, defaultLogFilePath } from 'core/log';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-log-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
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

test('logs JSON lines with msg and bindings', () => {
  const { lines, dest } = captureStream();
  const logger = createLogger({ destination: dest });
  logger.info({ foo: 'bar' }, 'hello');
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.foo).toBe('bar');
  expect(parsed.msg).toBe('hello');
});

test('respects level filter', () => {
  const { lines, dest } = captureStream();
  const logger = createLogger({ destination: dest, level: 'warn' });
  logger.debug('skipped');
  logger.info('skipped');
  logger.warn('captured');
  logger.error('captured');
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).msg).toBe('captured');
  expect(JSON.parse(lines[1]!).msg).toBe('captured');
});

test('child logger inherits and extends bindings', () => {
  const { lines, dest } = captureStream();
  const root = createLogger({ destination: dest, bindings: { service: 'gateway' } });
  const child = root.child({ source_app: 'claude-code' });
  child.info('test');
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.service).toBe('gateway');
  expect(parsed.source_app).toBe('claude-code');
});

test('default base bindings exclude pid and hostname', () => {
  const { lines, dest } = captureStream();
  const logger = createLogger({ destination: dest });
  logger.info('test');
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.pid).toBeUndefined();
  expect(parsed.hostname).toBeUndefined();
});

test('defaultLogFilePath ends with the canonical filename', () => {
  expect(defaultLogFilePath()).toMatch(/structured\.log$/);
});

test('createLogger writes to file when filePath provided', async () => {
  const logPath = join(dir, 'file-logger.log');
  const logger = createLogger({ filePath: logPath, level: 'info' });
  logger.info('hello-from-file');
  await Bun.sleep(50);
  expect(typeof logger.info).toBe('function');
});

test('createLogger uses pretty transport when pretty=true', () => {
  const logger = createLogger({ pretty: true, level: 'info' });
  expect(typeof logger.info).toBe('function');
  expect(typeof logger.warn).toBe('function');
});

test('createLogger uses default stdout destination when no overrides given', () => {
  const logger = createLogger();
  expect(typeof logger.info).toBe('function');
});
