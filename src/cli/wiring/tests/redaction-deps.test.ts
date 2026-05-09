import { expect, test } from 'bun:test';

import {
  buildRedactionListDeps,
  buildRedactionListOptions,
  buildRedactionTestDeps,
  buildRedactionTestOptions,
} from 'cli/wiring/redaction-deps.ts';

const ORIGINAL_LOG = console.log;
let captured: string[] = [];
function captureLog(): void {
  captured = [];
  console.log = (line?: string): void => {
    captured.push(String(line));
  };
}
function restoreLog(): void {
  console.log = ORIGINAL_LOG;
}

test('buildRedactionTestDeps: emit forwards a line to console.log', () => {
  const deps = buildRedactionTestDeps();
  captureLog();
  try {
    deps.emit('hello-test');
  } finally {
    restoreLog();
  }
  expect(captured).toEqual(['hello-test']);
  expect(typeof deps.output.info).toBe('function');
});

test('buildRedactionListDeps: emit forwards a line to console.log', () => {
  const deps = buildRedactionListDeps();
  captureLog();
  try {
    deps.emit('hello-list');
  } finally {
    restoreLog();
  }
  expect(captured).toEqual(['hello-list']);
  expect(typeof deps.output.info).toBe('function');
});

test('buildRedactionTestOptions: passes filePath and showRules through when set', () => {
  expect(buildRedactionTestOptions('/tmp/x.txt', { showRules: true })).toEqual({
    filePath: '/tmp/x.txt',
    showRules: true,
  });
});

test('buildRedactionTestOptions: omits showRules when false', () => {
  expect(buildRedactionTestOptions('/tmp/x.txt', { showRules: false })).toEqual({
    filePath: '/tmp/x.txt',
  });
});

test('buildRedactionTestOptions: handles missing showRules', () => {
  expect(buildRedactionTestOptions('/tmp/x.txt', {})).toEqual({ filePath: '/tmp/x.txt' });
});

test('buildRedactionListOptions: returns empty for empty input', () => {
  expect(buildRedactionListOptions({})).toEqual({});
});

test('buildRedactionListOptions: forwards each flag explicitly', () => {
  expect(
    buildRedactionListOptions({ categories: true, category: 'llm-providers', json: true }),
  ).toEqual({ categories: true, category: 'llm-providers', json: true });
});

test('buildRedactionListOptions: omits false flags', () => {
  expect(buildRedactionListOptions({ categories: false, json: false })).toEqual({});
});
