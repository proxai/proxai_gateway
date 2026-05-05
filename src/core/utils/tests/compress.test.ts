import { test, expect } from 'bun:test';

import { zstdCompressSync, zstdDecompressSync } from 'core/utils';

test('round-trips a string', () => {
  const original = 'hello world '.repeat(100);
  const compressed = zstdCompressSync(original);
  expect(compressed.byteLength).toBeLessThan(new TextEncoder().encode(original).byteLength);
  const restored = new TextDecoder().decode(zstdDecompressSync(compressed));
  expect(restored).toBe(original);
});

test('round-trips a Uint8Array', () => {
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const restored = zstdDecompressSync(zstdCompressSync(bytes));
  expect(restored).toEqual(bytes);
});

test('higher level produces smaller (or equal) output', () => {
  const payload = JSON.stringify({ data: 'x'.repeat(10_000) });
  const lvl3 = zstdCompressSync(payload, 3);
  const lvl19 = zstdCompressSync(payload, 19);
  expect(lvl19.byteLength).toBeLessThanOrEqual(lvl3.byteLength);
});
