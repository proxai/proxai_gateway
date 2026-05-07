import { expect, test } from 'bun:test';

import { currentGenerationNumber, nextGenerationSuffix, stripGenerationSuffix } from 'core/utils';

test('currentGenerationNumber returns 0 when no suffix is present', () => {
  expect(currentGenerationNumber('/path/to/state.vscdb')).toBe(0);
});

test('currentGenerationNumber returns 1 for #gen=1', () => {
  expect(currentGenerationNumber('/path/to/state.vscdb#gen=1')).toBe(1);
});

test('currentGenerationNumber returns 99 for #gen=99', () => {
  expect(currentGenerationNumber('/path/to/state.vscdb#gen=99')).toBe(99);
});

test('currentGenerationNumber returns 0 for malformed suffix (#gen=abc)', () => {
  expect(currentGenerationNumber('/path/to/state.vscdb#gen=abc')).toBe(0);
});

test('currentGenerationNumber returns 0 for #gen= (no number)', () => {
  expect(currentGenerationNumber('/path/to/state.vscdb#gen=')).toBe(0);
});

test('stripGenerationSuffix removes #gen=N when present', () => {
  expect(stripGenerationSuffix('/path/to/state.vscdb#gen=2')).toBe('/path/to/state.vscdb');
});

test('stripGenerationSuffix is a no-op when no suffix is present', () => {
  expect(stripGenerationSuffix('/path/to/state.vscdb')).toBe('/path/to/state.vscdb');
});

test('nextGenerationSuffix turns a bare path into #gen=1', () => {
  expect(nextGenerationSuffix('/path/to/state.vscdb')).toBe('/path/to/state.vscdb#gen=1');
});

test('nextGenerationSuffix increments #gen=1 to #gen=2', () => {
  expect(nextGenerationSuffix('/path/to/state.vscdb#gen=1')).toBe('/path/to/state.vscdb#gen=2');
});

test('nextGenerationSuffix increments #gen=2 to #gen=3', () => {
  expect(nextGenerationSuffix('/path/to/state.vscdb#gen=2')).toBe('/path/to/state.vscdb#gen=3');
});

test('nextGenerationSuffix increments past two-digit generations', () => {
  expect(nextGenerationSuffix('/path/to/state.vscdb#gen=99')).toBe('/path/to/state.vscdb#gen=100');
});

test('nextGenerationSuffix on malformed suffix treats it as gen=0 and produces #gen=1', () => {
  expect(nextGenerationSuffix('/path/to/state.vscdb#gen=abc')).toBe(
    '/path/to/state.vscdb#gen=abc#gen=1',
  );
});

test('successive applications of nextGenerationSuffix produce a monotonically increasing sequence', () => {
  let path = '/p/file.db';
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) {
    path = nextGenerationSuffix(path);
    seen.push(path);
  }
  expect(seen).toEqual([
    '/p/file.db#gen=1',
    '/p/file.db#gen=2',
    '/p/file.db#gen=3',
    '/p/file.db#gen=4',
    '/p/file.db#gen=5',
  ]);
});
