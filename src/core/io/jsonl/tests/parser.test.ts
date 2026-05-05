import { expect, test } from 'bun:test';

import { parseJsonl } from 'core/io/jsonl';

const enc = new TextEncoder();

test('parses well-formed JSONL', () => {
  const buf = enc.encode('{"a":1}\n{"b":2}\n');
  const out = Array.from(parseJsonl<Record<string, number>>(buf));
  expect(out).toHaveLength(2);
  expect(out[0]?.ok).toBe(true);
  expect(out[1]?.ok).toBe(true);
  if (out[0]?.ok && out[1]?.ok) {
    expect(out[0].data).toEqual({ a: 1 });
    expect(out[1].data).toEqual({ b: 2 });
  }
});

test('isolates a bad line — surrounding lines still parse', () => {
  const buf = enc.encode('{"a":1}\n{"b":\n{"c":3}\n');
  const out = Array.from(parseJsonl(buf));
  expect(out).toHaveLength(3);
  expect(out[0]?.ok).toBe(true);
  expect(out[1]?.ok).toBe(false);
  expect(out[2]?.ok).toBe(true);
  if (out[1] && !out[1].ok) {
    expect(out[1].error).toBeInstanceOf(Error);
    expect(out[1].rawLine).toBe('{"b":');
  }
});

test('skips empty lines', () => {
  const buf = enc.encode('{"a":1}\n\n{"b":2}\n');
  const out = Array.from(parseJsonl(buf));
  expect(out).toHaveLength(2);
});

test('reports byte offset relative to baseOffset', () => {
  const buf = enc.encode('{"a":1}\n{"b":2}\n');
  const out = Array.from(parseJsonl(buf, 1000));
  expect(out[0]?.byteOffset).toBe(1000);
  expect(out[1]?.byteOffset).toBe(1008);
});

test('handles trailing-newline-less input by ignoring the partial', () => {
  const buf = enc.encode('{"a":1}\n{"b":2');
  const out = Array.from(parseJsonl(buf));
  expect(out).toHaveLength(1);
});
