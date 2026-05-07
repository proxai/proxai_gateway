import { expect, test } from 'bun:test';

import { splitRowsByCompressedSize, zstdCompressSync } from 'core/utils';

interface Row {
  rowid: number;
  payload: string;
}

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
    measureCompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices.length).toBe(1);
  expect(slices[0]).toEqual(rows);
});

test('returns an empty array for an empty input', () => {
  const slices = splitRowsByCompressedSize([], {
    targetCompressedBytes: 1_024,
    measureCompressed: (s) => JSON.stringify(s).length,
  });
  expect(slices).toEqual([]);
});

test('splits across multiple slices each within budget', () => {
  const rows = makeRows(10, 60);
  const slices = splitRowsByCompressedSize(rows, {
    targetCompressedBytes: 300,
    measureCompressed: (s) => JSON.stringify(s).length,
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
    measureCompressed: (s) => JSON.stringify(s).length,
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
      measureCompressed: (s) => JSON.stringify(s).length,
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
    measureCompressed: (s) => zstdCompressSync(JSON.stringify(s)).byteLength,
  });
  const recovered = slices.flatMap((s) => s);
  expect(recovered).toEqual(rows);
});
