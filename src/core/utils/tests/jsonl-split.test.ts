import { expect, test } from 'bun:test';

import { splitJsonlAtBoundary, zstdCompressSync } from 'core/utils';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function lines(slice: Uint8Array): string[] {
  return DECODER.decode(slice)
    .split('\n')
    .filter((s) => s.length > 0);
}

test('returns the whole buffer in one slice when it fits the budget', () => {
  const bytes = ENCODER.encode('{"a":1}\n{"b":2}\n{"c":3}\n');
  const slices = splitJsonlAtBoundary(bytes, {
    targetCompressedBytes: 1_024 * 1_024,
    measureCompressed: (b) => b.byteLength,
  });
  expect(slices.length).toBe(1);
  expect(slices[0]).toEqual(bytes);
});

test('splits into multiple slices each under the target', () => {
  const line = '{"a":12}\n';
  const bytes = ENCODER.encode(line.repeat(6));
  const slices = splitJsonlAtBoundary(bytes, {
    targetCompressedBytes: 20,
    measureCompressed: (b) => b.byteLength,
  });
  expect(slices.length).toBeGreaterThanOrEqual(3);

  for (const slice of slices) {
    expect(slice.byteLength).toBeLessThanOrEqual(20);
    expect(slice[slice.byteLength - 1]).toBe(0x0a);
  }

  const concatenated = new Uint8Array(slices.reduce((n, s) => n + s.byteLength, 0));
  let offset = 0;
  for (const s of slices) {
    concatenated.set(s, offset);
    offset += s.byteLength;
  }
  expect(concatenated).toEqual(bytes);
});

test('throws when input does not end at a newline', () => {
  const bytes = ENCODER.encode('{"a":1}\n{"b":2}');
  expect(() =>
    splitJsonlAtBoundary(bytes, {
      targetCompressedBytes: 1_024,
      measureCompressed: (b) => b.byteLength,
    }),
  ).toThrow('newline');
});

test('throws when target budget is zero or negative', () => {
  const bytes = ENCODER.encode('{"a":1}\n');
  expect(() =>
    splitJsonlAtBoundary(bytes, {
      targetCompressedBytes: 0,
      measureCompressed: (b) => b.byteLength,
    }),
  ).toThrow();
});

test('emits a single oversized slice when even one line exceeds budget', () => {
  const oneBig = `${'x'.repeat(98)}\n`;
  const bytes = ENCODER.encode(oneBig);
  const slices = splitJsonlAtBoundary(bytes, {
    targetCompressedBytes: 10,
    measureCompressed: (b) => b.byteLength,
  });
  expect(slices.length).toBe(1);
  expect(slices[0]).toEqual(bytes);
});

test('returns an empty array for an empty input', () => {
  const slices = splitJsonlAtBoundary(new Uint8Array(0), {
    targetCompressedBytes: 100,
    measureCompressed: (b) => b.byteLength,
  });
  expect(slices).toEqual([]);
});

test('preserves all original lines across slices (real zstd compressor)', () => {
  const lineCount = 200;
  const linesArr: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    linesArr.push(
      JSON.stringify({ i, payload: `row-${i.toString()}-${Math.random().toString(36)}` }),
    );
  }
  const text = `${linesArr.join('\n')}\n`;
  const bytes = ENCODER.encode(text);

  const slices = splitJsonlAtBoundary(bytes, {
    targetCompressedBytes: 256,
    measureCompressed: (b) => zstdCompressSync(b).byteLength,
  });

  let recovered: string[] = [];
  for (const slice of slices) {
    recovered = recovered.concat(lines(slice));
  }
  expect(recovered.length).toBe(lineCount);
  expect(recovered).toEqual(linesArr);
});
