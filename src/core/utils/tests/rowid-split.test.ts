import { expect, test } from 'bun:test';

import { splitRowsByCompressedSize, zstdCompressSync } from 'core/utils';

interface Row {
  rowid: number;
  payload: string;
}

const HUGE = 1_000_000_000;

const measureRowCountDiv100 = (s: readonly Row[]): number =>
  Math.max(1, Math.floor(s.length / 100));

function makeRows(count: number, payloadLen: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push({ rowid: i, payload: 'x'.repeat(payloadLen) });
  }
  return rows;
}

test('returns the full row list in one slice when it fits the budget', () => {
  const rows = makeRows(5, 8);
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 1_024,
    maxDecompressedBytes: HUGE,
    measureCompressed: (s) => JSON.stringify(s).length,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices.length).toBe(1);
  expect(slices[0]).toEqual(rows);
});

test('returns an empty array for an empty input', () => {
  const slices = splitRowsByCompressedSize([], {
    targetCompressedBytes: 1_024,
    maxDecompressedBytes: HUGE,
    measureCompressed: (s) => JSON.stringify(s).length,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices).toEqual([]);
});

test('splits across multiple slices each within budget', () => {
  const rows = makeRows(10, 60);
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 300,
    maxDecompressedBytes: HUGE,
    measureCompressed: (s) => JSON.stringify(s).length,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices.length).toBeGreaterThan(1);

  for (const slice of slices) {
    expect(JSON.stringify(slice).length).toBeLessThanOrEqual(300);
  }

  const recovered = slices.flatMap((s) => s);
  expect(recovered).toEqual(rows);
});

test('emits single-row chunk when one row exceeds budget (caller surfaces failure)', () => {
  const oversized: Row = { rowid: 1, payload: 'x'.repeat(10_000) };
  const small = makeRows(3, 10).map((r) => ({ ...r, rowid: r.rowid + 1 }));
  const rows = [oversized, ...small];

  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 200,
    maxDecompressedBytes: HUGE,
    measureCompressed: (s) => JSON.stringify(s).length,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices.length).toBeGreaterThanOrEqual(2);
  expect(slices[0]).toEqual([oversized]);

  for (let i = 1; i < slices.length; i++) {
    expect(JSON.stringify(slices[i]).length).toBeLessThanOrEqual(200);
  }
});

test('throws when target budget is zero or negative', () => {
  expect(() =>
    splitRowsByCompressedSize(makeRows(3, 10), {
      targetCompressedBytes: 0,
      maxDecompressedBytes: HUGE,
      measureCompressed: (s) => JSON.stringify(s).length,
      measureUncompressed: (s) => JSON.stringify(s).length,
    }),
  ).toThrow();
});

test('throws when maxDecompressedBytes is zero or negative', () => {
  expect(() =>
    splitRowsByCompressedSize(makeRows(3, 10), {
      targetCompressedBytes: 1_024,
      maxDecompressedBytes: 0,
      measureCompressed: (s) => JSON.stringify(s).length,
      measureUncompressed: (s) => JSON.stringify(s).length,
    }),
  ).toThrow();
});

test('preserves all rows across slices using a real zstd measurer', () => {
  const rowCount = 50;
  const rows: Row[] = [];
  for (let i = 1; i <= rowCount; i++) {
    rows.push({ rowid: i, payload: `r-${i.toString()}-${'noise'.repeat(20)}` });
  }
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 200,
    maxDecompressedBytes: HUGE,
    measureCompressed: (s) => zstdCompressSync(JSON.stringify(s)).byteLength,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  const recovered = slices.flatMap((s) => s);
  expect(recovered).toEqual(rows);
});

test('splits early when raw row bytes exceed maxDecompressedBytes even if compressed budget is not yet hit', () => {
  const rows = makeRows(20, 30);
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 100_000,
    maxDecompressedBytes: 200,
    measureCompressed: measureRowCountDiv100,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices.length).toBeGreaterThan(1);
  for (const slice of slices) {
    if (slice.length > 1) {
      expect(JSON.stringify(slice).length).toBeLessThanOrEqual(200);
    }
  }
});

test('emits single-row chunk when one row exceeds maxDecompressedBytes', () => {
  const oversized: Row = { rowid: 1, payload: 'x'.repeat(10_000) };
  const small = makeRows(3, 10).map((r) => ({ ...r, rowid: r.rowid + 1 }));
  const rows = [oversized, ...small];

  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 1_000_000,
    maxDecompressedBytes: 200,
    measureCompressed: (s) => zstdCompressSync(JSON.stringify(s)).byteLength,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices[0]).toEqual([oversized]);
  for (let i = 1; i < slices.length; i++) {
    expect(JSON.stringify(slices[i]).length).toBeLessThanOrEqual(200);
  }
});

test('every slice honors BOTH targetCompressedBytes AND maxDecompressedBytes simultaneously', () => {
  const rows = makeRows(40, 30);
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 100,
    maxDecompressedBytes: 150,
    measureCompressed: (s) => zstdCompressSync(JSON.stringify(s)).byteLength,
    measureUncompressed: (s) => JSON.stringify(s).length,
  });

  for (const slice of slices) {
    if (slice.length > 1) {
      expect(zstdCompressSync(JSON.stringify(slice)).byteLength).toBeLessThanOrEqual(100);
      expect(JSON.stringify(slice).length).toBeLessThanOrEqual(150);
    }
  }
});
