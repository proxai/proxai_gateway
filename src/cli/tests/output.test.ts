import { expect, test } from 'bun:test';

import { captureOutput, consoleOutput, silentOutput } from 'cli/output.ts';

test('captureOutput records every level', () => {
  const out = captureOutput();
  out.info('a');
  out.warn('b');
  out.error('c');
  out.success('d');
  expect(out.lines).toEqual([
    { level: 'info', msg: 'a' },
    { level: 'warn', msg: 'b' },
    { level: 'error', msg: 'c' },
    { level: 'success', msg: 'd' },
  ]);
});

test('silentOutput discards every message without throwing', () => {
  const out = silentOutput();
  expect(() => {
    out.info('a');
    out.warn('b');
    out.error('c');
    out.success('d');
  }).not.toThrow();
});

test('consoleOutput exposes the four required methods', () => {
  const out = consoleOutput();
  expect(typeof out.info).toBe('function');
  expect(typeof out.warn).toBe('function');
  expect(typeof out.error).toBe('function');
  expect(typeof out.success).toBe('function');
});

test('consoleOutput methods do not throw when invoked', () => {
  const out = consoleOutput();
  const originalLog = console.log;
  const originalErr = console.error;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    expect(() => {
      out.info('x');
      out.warn('x');
      out.error('x');
      out.success('x');
    }).not.toThrow();
  } finally {
    console.log = originalLog;
    console.error = originalErr;
    console.warn = originalWarn;
  }
});
