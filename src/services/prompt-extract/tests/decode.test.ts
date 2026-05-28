import { expect, test } from 'bun:test';

import { zstdCompressSync } from 'core/utils';
import { decompressBody } from 'services/prompt-extract/decode.ts';

test('decompressBody round-trips zstd-compressed utf-8 text', () => {
  const original = 'hello world with unicode: café ☕';
  const body = zstdCompressSync(original);
  expect(decompressBody(body)).toBe(original);
});

test('decompressBody returns null when the body is not valid zstd', () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5]);
  expect(decompressBody(garbage)).toBeNull();
});

test('decompressBody returns empty string for compressed empty input', () => {
  const body = zstdCompressSync('');
  expect(decompressBody(body)).toBe('');
});

test('decompressBody tolerates invalid utf-8 byte sequences without throwing', () => {
  const body = zstdCompressSync(new Uint8Array([0xff, 0xfe, 0x41]));
  const decoded = decompressBody(body);
  expect(decoded).not.toBeNull();
});
